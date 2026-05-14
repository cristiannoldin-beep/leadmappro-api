import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function campanhasRoutes(app: FastifyInstance) {
  app.get('/campanhas', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const campanhas = await prisma.campanha.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      include: { lista: { select: { nome: true } }, _count: { select: { campanhaContatos: true } } },
    })
    return reply.send({ campanhas })
  })

  app.post('/campanhas', { preValidation: [requireAuth] }, async (request, reply) => {
    const { sub: userId, accountId } = request.user as JwtPayload
    const body = z.object({
      nome: z.string().min(1),
      listaId: z.string().uuid(),
      tipo: z.enum(['prospeccao_fria', 'reativacao_inativos']),
      limiteEnviosDia: z.number().int().positive().default(20),
      delayMinutos: z.number().int().positive().default(3),
      mensagemBase: z.string().min(1),
      horarioInicio: z.string().default('09:00:00'),
      horarioFim: z.string().default('18:00:00'),
      conexaoId: z.string().uuid().optional(),
      providerDisparo: z.enum(['meta_official', 'uazapi']).optional(),
    }).parse(request.body)

    const campanha = await prisma.campanha.create({ data: { ...body, userId, accountId } })
    return reply.status(201).send({ campanha })
  })

  app.get('/campanhas/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const campanha = await prisma.campanha.findFirst({
      where: { id, accountId },
      include: {
        lista: { select: { nome: true } },
        _count: { select: { campanhaContatos: true } },
      },
    })
    if (!campanha) return reply.status(404).send({ message: 'Campanha não encontrada.' })
    return reply.send({ campanha })
  })

  app.patch('/campanhas/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      nome: z.string().optional(),
      ativo: z.boolean().optional(),
      limiteEnviosDia: z.number().optional(),
      delayMinutos: z.number().optional(),
      mensagemBase: z.string().optional(),
    }).parse(request.body)

    const exists = await prisma.campanha.findFirst({ where: { id, accountId } })
    if (!exists) return reply.status(404).send({ message: 'Campanha não encontrada.' })

    const campanha = await prisma.campanha.update({ where: { id }, data: body })
    return reply.send({ campanha })
  })

  app.delete('/campanhas/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const exists = await prisma.campanha.findFirst({ where: { id, accountId } })
    if (!exists) return reply.status(404).send({ message: 'Campanha não encontrada.' })
    await prisma.campanha.delete({ where: { id } })
    return reply.status(204).send()
  })

  // Endpoint chamado pelo cron do Coolify (substitui pg_cron do Supabase)
  app.post('/campanhas/cron/disparar', async (request, reply) => {
    const cronSecret = request.headers['x-cron-secret']
    if (cronSecret !== process.env.CRON_SECRET) {
      return reply.status(401).send({ message: 'Não autorizado.' })
    }

    // TODO: migrar lógica de disparo da Edge Function `disparar-mensagens`
    return reply.send({ message: 'Disparo em processamento.' })
  })
}
