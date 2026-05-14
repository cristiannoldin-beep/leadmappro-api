import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'

export async function iaRoutes(app: FastifyInstance) {
  // Substitui: melhorar-mensagem-ia
  app.post('/ia/melhorar-mensagem', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      mensagem: z.string().min(1),
      contexto: z.string().optional(),
    }).parse(request.body)

    // TODO: chamar OpenAI/Gemini para melhorar mensagem
    return reply.send({ mensagemMelhorada: body.mensagem, message: 'TODO: melhorar com IA' })
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
