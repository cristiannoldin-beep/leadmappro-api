import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/stats', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload

    const [listas, campanhas, contatos, oportunidades] = await Promise.all([
      prisma.lista.count({ where: { accountId } }),
      prisma.campanha.count({ where: { accountId, ativo: true } }),
      prisma.listaContato.count({
        where: { lista: { accountId } },
      }),
      prisma.oportunidade.count({
        where: {
          etapa: { notIn: ['fechado', 'perdido'] },
          contato: { listaContatos: { some: { lista: { accountId } } } },
        },
      }),
    ])

    return reply.send({ listas, campanhas, contatos, oportunidades })
  })
}
