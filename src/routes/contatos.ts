import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function contatosRoutes(app: FastifyInstance) {
  app.get('/contatos', { preValidation: [requireAuth] }, async (request, reply) => {
    const query = z.object({
      listaId: z.string().uuid().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(request.query)

    const { accountId } = request.user as JwtPayload
    const skip = (query.page - 1) * query.limit

    const where = query.listaId
      ? { listaContatos: { some: { lista: { id: query.listaId, accountId } } } }
      : { listaContatos: { some: { lista: { accountId } } } }

    const [contatos, total] = await Promise.all([
      prisma.contato.findMany({ where, skip, take: query.limit, orderBy: { createdAt: 'desc' } }),
      prisma.contato.count({ where }),
    ])

    return reply.send({ contatos, total, page: query.page, limit: query.limit })
  })

  app.post('/contatos', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      nomeEmpresa: z.string().min(1),
      contatoNome: z.string().optional(),
      telefone: z.string().min(8),
      endereco: z.string().optional(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
      cnpj: z.string().optional(),
      listaId: z.string().uuid().optional(),
    }).parse(request.body)

    const { listaId, ...contatoData } = body
    const contato = await prisma.contato.create({ data: contatoData })

    if (listaId) {
      await prisma.listaContato.create({ data: { listaId, contatoId: contato.id } }).catch(() => null)
    }

    return reply.status(201).send({ contato })
  })

  app.get('/contatos/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const contato = await prisma.contato.findUnique({
      where: { id },
      include: { interacoes: { orderBy: { data: 'desc' }, take: 20 } },
    })
    if (!contato) return reply.status(404).send({ message: 'Contato não encontrado.' })
    return reply.send({ contato })
  })

  app.patch('/contatos/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      nomeEmpresa: z.string().optional(),
      contatoNome: z.string().optional(),
      telefone: z.string().optional(),
      endereco: z.string().optional(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
      cnpj: z.string().optional(),
    }).parse(request.body)

    const contato = await prisma.contato.update({ where: { id }, data: body })
    return reply.send({ contato })
  })

  app.get('/contatos/:id/foto-perfil', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const contato = await prisma.contato.findUnique({ where: { id }, select: { telefone: true } })
    if (!contato) return reply.status(404).send({ message: 'Contato não encontrado.' })

    // TODO: integrar com provider WhatsApp para buscar foto de perfil
    return reply.send({ fotoUrl: null })
  })
}
