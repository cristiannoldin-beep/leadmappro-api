import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'

export async function iaRoutes(app: FastifyInstance) {
  // Melhora mensagem de prospecção com OpenAI
  app.post('/ia/melhorar-mensagem', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      mensagem: z.string().min(1),
      contexto: z.string().optional(),
    }).parse(request.body)

    const cred = await prisma.credencial.findUnique({ where: { accountId_chave: { accountId, chave: 'OPENAI_API_KEY' } } })
    if (!cred?.ativa) return reply.status(400).send({ message: 'Credencial OpenAI não configurada.' })

    const { decrypt } = await import('../lib/encryption')
    const openaiKey = decrypt(cred.valorCriptografado)

    const iaConfig = await prisma.iaConfiguracaoEstilo.findUnique({ where: { accountId } })
    const estilo = iaConfig?.estiloResposta ?? 'Seja cordial, direto ao ponto e profissional.'

    const prompt = `Você é especialista em copywriting para prospecção B2B via WhatsApp.
Melhore a seguinte mensagem de prospecção mantendo o mesmo objetivo e variáveis como {nome_empresa}, {cidade}.
Estilo desejado: ${estilo}
${body.contexto ? `Contexto adicional: ${body.contexto}` : ''}

Mensagem original:
${body.mensagem}

Responda APENAS com a mensagem melhorada, sem explicações ou prefixos.`

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 300,
      }),
    })

    if (!res.ok) return reply.status(502).send({ message: 'Erro ao chamar OpenAI.' })
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const mensagemMelhorada = data.choices?.[0]?.message?.content?.trim() ?? body.mensagem

    return reply.send({ mensagemMelhorada })
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
