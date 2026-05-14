import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'

export async function sdrRoutes(app: FastifyInstance) {
  app.get('/sdr/configuracao', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const config = await prisma.sdrConfiguracao.findUnique({ where: { accountId } })
    return reply.send({ config })
  })

  app.put('/sdr/configuracao', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      ativo: z.boolean().optional(),
      mensagemFollowup1: z.string().optional(),
      mensagemFollowup2: z.string().optional(),
      delayFollowup1Horas: z.number().optional(),
      delayFollowup2Horas: z.number().optional(),
    }).parse(request.body)

    const config = await prisma.sdrConfiguracao.upsert({
      where: { accountId },
      update: { ...body, updatedAt: new Date() },
      create: { accountId, ...body },
    })
    return reply.send({ config })
  })

  // Substitui: processar-followup-sdr
  app.post('/sdr/processar-followup', async (request, reply) => {
    const cronSecret = request.headers['x-cron-secret']
    if (cronSecret !== process.env.CRON_SECRET) {
      return reply.status(401).send({ message: 'Não autorizado.' })
    }
    // TODO: migrar lógica de processar-followup-sdr
    return reply.send({ processados: 0 })
  })
}
