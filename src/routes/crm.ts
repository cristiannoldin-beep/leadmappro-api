import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function crmRoutes(app: FastifyInstance) {
  app.get('/crm/oportunidades', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const oportunidades = await prisma.oportunidade.findMany({
      where: { contato: { listaContatos: { some: { lista: { accountId } } } } },
      include: { contato: { select: { id: true, nomeEmpresa: true, telefone: true, cidade: true, estado: true } } },
      orderBy: { dataCriacao: 'desc' },
    })
    return reply.send({
      oportunidades: oportunidades.map(o => ({
        ...o,
        valorEstimado: o.valorEstimado ? Number(o.valorEstimado) : null,
      })),
    })
  })

  app.post('/crm/oportunidades', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      contatoId: z.string().uuid(),
      etapa: z.enum(['novo', 'contato_feito', 'proposta', 'negociacao', 'fechado', 'perdido']).default('novo'),
      valorEstimado: z.number().optional(),
      origemCampanhaId: z.string().uuid().optional(),
    }).parse(request.body)

    // Verificar que o contato pertence à conta
    const contato = await prisma.contato.findFirst({
      where: { id: body.contatoId, listaContatos: { some: { lista: { accountId } } } },
    })
    if (!contato) return reply.status(404).send({ message: 'Contato não encontrado.' })

    const oportunidade = await prisma.oportunidade.create({ data: body })
    return reply.status(201).send({ oportunidade: { ...oportunidade, valorEstimado: oportunidade.valorEstimado ? Number(oportunidade.valorEstimado) : null } })
  })

  app.patch('/crm/oportunidades/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      etapa: z.enum(['novo', 'contato_feito', 'proposta', 'negociacao', 'fechado', 'perdido']).optional(),
      valorEstimado: z.number().optional().nullable(),
    }).parse(request.body)

    const oportunidade = await prisma.oportunidade.update({ where: { id }, data: body })
    return reply.send({ oportunidade: { ...oportunidade, valorEstimado: oportunidade.valorEstimado ? Number(oportunidade.valorEstimado) : null } })
  })

  app.delete('/crm/oportunidades/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await prisma.oportunidade.delete({ where: { id } })
    return reply.status(204).send()
  })
}
