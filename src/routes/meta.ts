import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'

export async function metaRoutes(app: FastifyInstance) {
  // Substitui: meta-oauth-exchange
  app.post('/meta/oauth-exchange', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({ code: z.string(), redirectUri: z.string().url() }).parse(request.body)
    // TODO: trocar code por access token via Meta Graph API
    return reply.send({ accessToken: null, message: 'TODO: Meta OAuth exchange' })
  })

  app.get('/meta/templates', { preValidation: [requireAuth] }, async (_request, reply) => {
    const templates = await prisma.metaTemplate.findMany({ orderBy: { createdAt: 'desc' } })
    return reply.send({ templates })
  })

  // Substitui: gerar-meta-template-ia
  app.post('/meta/templates/gerar', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      categoria: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
      descricao: z.string().min(10),
      variaveis: z.array(z.string()).optional(),
    }).parse(request.body)

    // TODO: gerar template com IA e salvar no banco
    return reply.send({ template: null, message: 'TODO: gerar template Meta com IA' })
  })
}
