import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAdmin, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/accounts', { preValidation: [requireAdmin] }, async (request, reply) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(20) }).parse(request.query)
    const skip = (query.page - 1) * query.limit
    const [accounts, total] = await Promise.all([
      prisma.account.findMany({ skip, take: query.limit, orderBy: { createdAt: 'desc' } }),
      prisma.account.count(),
    ])
    return reply.send({ accounts, total })
  })

  app.get('/admin/logs', { preValidation: [requireAdmin] }, async (request, reply) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(50) }).parse(request.query)
    const skip = (query.page - 1) * query.limit
    // TODO: tabela de logs de auditoria
    return reply.send({ logs: [], total: 0 })
  })

  app.get('/admin/infra', { preValidation: [requireAdmin] }, async (_request, reply) => {
    const [profiles, accounts, conexoes] = await Promise.all([
      prisma.profile.count(),
      prisma.account.count(),
      prisma.whatsappConexao.count(),
    ])
    return reply.send({ stats: { profiles, accounts, conexoes } })
  })

  app.patch('/admin/accounts/:id', { preValidation: [requireAdmin] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({ status: z.string().optional(), planId: z.string().optional() }).parse(request.body)
    const account = await prisma.account.update({ where: { id }, data: body })
    return reply.send({ account })
  })
}
