import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'

export async function iaRoutes(app: FastifyInstance) {
  // Melhora/transforma mensagem com OpenAI — suporta ações do chat composer
  app.post('/ia/melhorar-mensagem', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      mensagem: z.string().min(1),
      contexto: z.string().optional(),
      acaoChat: z.enum(['expandir', 'reformular', 'meu_tom', 'amigavel', 'formal', 'gramatica', 'traduzir']).optional(),
      idiomaDestino: z.string().optional(),
    }).parse(request.body)

    const cred = await prisma.credencial.findUnique({ where: { accountId_chave: { accountId, chave: 'OPENAI_API_KEY' } } })
    if (!cred?.ativa) return reply.status(400).send({ message: 'Credencial OpenAI não configurada.' })

    const { decrypt } = await import('../lib/encryption')
    const openaiKey = decrypt(cred.valorCriptografado)

    const iaConfig = await prisma.iaConfiguracaoEstilo.findUnique({ where: { accountId } })
    const estilo = iaConfig?.estiloResposta ?? 'Seja cordial, direto ao ponto e profissional.'

    const instrucaoAcao = (() => {
      switch (body.acaoChat) {
        case 'expandir': return 'Expanda a mensagem com mais detalhes e argumentos, mantendo o objetivo.'
        case 'reformular': return 'Reformule a mensagem com palavras diferentes mas mesmo significado.'
        case 'amigavel': return 'Reescreva de forma mais amigável, leve e próxima.'
        case 'formal': return 'Reescreva de forma mais formal e profissional.'
        case 'gramatica': return 'Corrija apenas erros gramaticais e ortográficos, sem alterar o conteúdo.'
        case 'traduzir': return `Traduza para o idioma: ${body.idiomaDestino ?? 'inglês'}. Mantenha variáveis como {nome_empresa}.`
        case 'meu_tom': return `Reescreva no estilo: ${estilo}`
        default: return `Melhore a mensagem. Estilo desejado: ${estilo}`
      }
    })()

    const prompt = `Você é especialista em copywriting para WhatsApp.
${instrucaoAcao}
${body.contexto ? `Contexto: ${body.contexto}` : ''}

Mensagem:
${body.mensagem}

Responda APENAS com o texto resultante, sem explicações ou prefixos.`

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 400,
      }),
    })

    if (!res.ok) return reply.status(502).send({ message: 'Erro ao chamar OpenAI.' })
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const mensagemMelhorada = data.choices?.[0]?.message?.content?.trim() ?? body.mensagem

    return reply.send({ mensagemMelhorada, sucesso: true })
  })

  app.get('/ia/configuracao', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const config = await prisma.iaConfiguracaoEstilo.findUnique({ where: { accountId } })
    return reply.send({ config })
  })

  app.put('/ia/configuracao', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      estiloResposta: z.string().optional(),
      exemplosMensagens: z.string().optional(),
    }).parse(request.body)

    const config = await prisma.iaConfiguracaoEstilo.upsert({
      where: { accountId },
      update: { ...body, updatedAt: new Date() },
      create: { accountId, ...body },
    })
    return reply.send({ config })
  })
}
