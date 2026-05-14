import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function listasRoutes(app: FastifyInstance) {
  app.get('/listas', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const listas = await prisma.lista.findMany({
      where: { accountId },
      orderBy: { dataCriacao: 'desc' },
      include: { _count: { select: { listaContatos: true } } },
    })
    return reply.send({ listas })
  })

  app.post('/listas', { preValidation: [requireAuth] }, async (request, reply) => {
    const { sub: userId, accountId } = request.user as JwtPayload
    const body = z.object({
      nome: z.string().min(1),
      origem: z.enum(['google_maps', 'parceiro_inativo', 'econodata', 'importacao']),
      segmento: z.string().optional(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
      parceiroId: z.string().uuid().optional(),
    }).parse(request.body)

    const lista = await prisma.lista.create({
      data: { ...body, userId, accountId },
    })
    return reply.status(201).send({ lista })
  })

  app.get('/listas/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const lista = await prisma.lista.findFirst({
      where: { id, accountId },
      include: { _count: { select: { listaContatos: true } } },
    })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })
    return reply.send({ lista })
  })

  app.delete('/listas/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const lista = await prisma.lista.findFirst({ where: { id, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })
    await prisma.lista.delete({ where: { id } })
    return reply.status(204).send()
  })

  app.get('/listas/:id/exportar', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const lista = await prisma.lista.findFirst({ where: { id, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const contatos = await prisma.listaContato.findMany({
      where: { listaId: id },
      include: { contato: true },
    })

    const rows = contatos.map((lc) => ({
      id: lc.contato.id,
      nome_empresa: lc.contato.nomeEmpresa,
      contato_nome: lc.contato.contatoNome ?? '',
      telefone: lc.contato.telefone,
      cidade: lc.contato.cidade ?? '',
      estado: lc.contato.estado ?? '',
      cnpj: lc.contato.cnpj ?? '',
      status_whatsapp: lc.statusWhatsapp,
      status_na_lista: lc.statusNaLista,
    }))

    const header = Object.keys(rows[0] ?? {}).join(',')
    const csv = [header, ...rows.map((r) => Object.values(r).map((v) => `"${v}"`).join(','))].join('\n')

    return reply
      .header('Content-Type', 'text/csv')
      .header('Content-Disposition', `attachment; filename="lista-${id}.csv"`)
      .send(csv)
  })

  app.post('/listas/:id/validar-whatsapp', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload

    const lista = await prisma.lista.findFirst({ where: { id, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    return reply.send({ message: 'Validação em background iniciada.', listaId: id })
  })
}
