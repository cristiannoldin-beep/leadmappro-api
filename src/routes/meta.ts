import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'
import { getCredencial } from '../lib/credencial'

export async function metaRoutes(app: FastifyInstance) {
  // Troca OAuth code por access token e cria conexão WhatsApp Oficial
  app.post('/meta/oauth-exchange', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({ code: z.string(), redirectUri: z.string().url().optional() }).parse(request.body)

    const metaAppId = process.env.META_APP_ID
    const metaAppSecret = process.env.META_APP_SECRET
    if (!metaAppId || !metaAppSecret) {
      return reply.status(400).send({ message: 'META_APP_ID e META_APP_SECRET não configurados no servidor.' })
    }

    // 1. Trocar code por access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${metaAppId}&client_secret=${metaAppSecret}&code=${body.code}`,
    )
    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({}))
      return reply.status(502).send({ message: `Erro Meta OAuth: ${JSON.stringify(err)}` })
    }
    const tokenData = await tokenRes.json() as { access_token?: string; error?: unknown }
    const accessToken = tokenData.access_token
    if (!accessToken) return reply.status(502).send({ message: 'Token de acesso não retornado pela Meta.' })

    // 2. Debug token para extrair WABA e phone_number_id
    const debugRes = await fetch(
      `https://graph.facebook.com/v19.0/debug_token?input_token=${accessToken}&access_token=${metaAppId}|${metaAppSecret}`,
    )
    const debugData = await debugRes.json() as { data?: { granular_scopes?: { scope: string; target_ids?: string[] }[] } }
    const wabaScope = debugData.data?.granular_scopes?.find((s) => s.scope === 'whatsapp_business_management')
    const wabaId = wabaScope?.target_ids?.[0] ?? null

    // 3. Buscar phone number IDs da WABA
    let phoneNumberId: string | null = null
    let phoneNumber: string | null = null
    if (wabaId) {
      const phonesRes = await fetch(
        `https://graph.facebook.com/v19.0/${wabaId}/phone_numbers?access_token=${accessToken}`,
      )
      if (phonesRes.ok) {
        const phonesData = await phonesRes.json() as { data?: { id: string; display_phone_number: string }[] }
        phoneNumberId = phonesData.data?.[0]?.id ?? null
        phoneNumber = phonesData.data?.[0]?.display_phone_number ?? null
      }
    }

    // 4. Salvar conexão
    const existing = await prisma.whatsappConexao.findFirst({
      where: { accountId, provider: 'meta_official' },
    })
    const conexaoData = {
      accountId,
      provider: 'meta_official',
      status: 'connected',
      apelido: 'WhatsApp Business (Meta Oficial)',
      instanceName: wabaId ?? 'meta-oficial',
      accessToken,
      wabaId,
      phoneNumberId,
      numeroTelefone: phoneNumber,
    }
    const conexao = existing
      ? await prisma.whatsappConexao.update({ where: { id: existing.id }, data: conexaoData })
      : await prisma.whatsappConexao.create({ data: conexaoData })

    return reply.send({ conexaoId: conexao.id, wabaId, phoneNumberId, phoneNumber })
  })

  app.get('/meta/templates', { preValidation: [requireAuth] }, async (_request, reply) => {
    const templates = await prisma.metaTemplate.findMany({ orderBy: { createdAt: 'desc' } })
    return reply.send({ templates })
  })

  // Gera template Meta com IA
  app.post('/meta/templates/gerar', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      instrucao: z.string().min(5),
      categoria: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).default('MARKETING'),
    }).parse(request.body)

    const openaiKey = await getCredencial(accountId, 'OPENAI_API_KEY')
    if (!openaiKey) return reply.status(400).send({ message: 'Credencial OpenAI não configurada.' })

    const prompt = `Você é especialista em templates de WhatsApp Business (Meta).
Gere um template aprovável pela Meta com base na instrução abaixo.
Categoria: ${body.categoria}

Regras obrigatórias:
- Máximo 1024 caracteres
- Variáveis no formato {{1}}, {{2}}, etc.
- Sem URLs encurtadas
- Sem promessas financeiras (não use "ganhe dinheiro")
- Linguagem profissional e objetiva

Instrução: ${body.instrucao}

Responda APENAS em JSON:
{
  "nome": "snake_case_max_512_chars",
  "corpo": "texto do template com {{1}} para variáveis",
  "variaveis": ["descrição da var 1", "descrição da var 2"],
  "rodape": "texto opcional do rodapé ou null",
  "observacoes": "dicas para aprovação"
}`

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) return reply.status(502).send({ message: 'Erro ao chamar OpenAI.' })

    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const template = JSON.parse(data.choices?.[0]?.message?.content ?? '{}')

    // Salvar rascunho no banco
    const saved = await prisma.metaTemplate.create({
      data: {
        nome: template.nome ?? 'template_gerado',
        categoria: body.categoria,
        corpo: template.corpo ?? '',
        status: 'rascunho',
        variaveis: template.variaveis ?? [],
      },
    })

    return reply.status(201).send({ template: { ...template, id: saved.id } })
  })
}
