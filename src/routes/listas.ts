import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, requireActiveAccount, JwtPayload } from '../lib/auth'

export async function listasRoutes(app: FastifyInstance) {
  app.get('/listas', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const raw = await prisma.lista.findMany({
      where: { accountId },
      orderBy: { dataCriacao: 'desc' },
      include: { _count: { select: { listaContatos: true } } },
    })
    const listas = raw.map((l) => ({ ...l, createdAt: l.dataCriacao, totalContatos: l._count.listaContatos }))
    return reply.send({ listas })
  })

  app.post('/listas', { preValidation: [requireActiveAccount] }, async (request, reply) => {
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
    const raw = await prisma.lista.findFirst({
      where: { id, accountId },
      include: { _count: { select: { listaContatos: true } } },
    })
    if (!raw) return reply.status(404).send({ message: 'Lista não encontrada.' })
    const lista = { ...raw, createdAt: raw.dataCriacao, totalContatos: raw._count.listaContatos }
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

  app.get('/listas/:id/contatos', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const { page = '1', limit = '500' } = request.query as Record<string, string>

    const lista = await prisma.lista.findFirst({ where: { id, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const skip = (Number(page) - 1) * Number(limit)
    const [listaContatos, total] = await Promise.all([
      prisma.listaContato.findMany({
        where: { listaId: id },
        include: { contato: true },
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.listaContato.count({ where: { listaId: id } }),
    ])

    // Bulk-compute outras_listas por contato
    const contatoIds = listaContatos.map((lc) => lc.contatoId)
    const outrasRaw = await prisma.listaContato.findMany({
      where: { contatoId: { in: contatoIds }, listaId: { not: id } },
      select: { contatoId: true, listaId: true },
    })
    const outrasMap = new Map<string, string[]>()
    for (const row of outrasRaw) {
      const arr = outrasMap.get(row.contatoId) ?? []
      arr.push(row.listaId)
      outrasMap.set(row.contatoId, arr)
    }

    const contatos = listaContatos.map((lc) => ({
      id: lc.id,
      lista_id: lc.listaId,
      contato_id: lc.contatoId,
      status_whatsapp: lc.statusWhatsapp,
      mensagem_enviada: lc.mensagemEnviada,
      fonte_busca: lc.fonteBusca,
      created_at: lc.createdAt,
      contatos: {
        id: lc.contato.id,
        nome_empresa: lc.contato.nomeEmpresa,
        contato_nome: lc.contato.contatoNome,
        telefone: lc.contato.telefone,
        endereco: lc.contato.endereco,
        cidade: lc.contato.cidade,
        estado: lc.contato.estado,
        cnpj: lc.contato.cnpj,
        atividade: lc.contato.atividade ?? lc.contato.atividadePrincipal,
        website: lc.contato.website,
        email: lc.contato.email,
        instagram: lc.contato.instagram,
        linkedin: lc.contato.linkedin,
        descricao: lc.contato.descricao,
        enriquecido_em: lc.contato.enriquecidoEm,
        gancho_personalizacao: lc.contato.ganchoPersonalizacao,
        prova_social: lc.contato.provaSocial,
      },
      outras_listas: outrasMap.get(lc.contatoId) ?? [],
    }))

    const hasMore = skip + listaContatos.length < total
    return reply.send({ contatos, total, page: Number(page), limit: Number(limit), hasMore })
  })

  app.patch('/listas/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      googleQueriesUsadas: z.array(z.string()).optional(),
      googleVariacoesIa: z.array(z.string()).optional(),
      nome: z.string().optional(),
      segmento: z.string().optional(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
    }).parse(request.body)

    const lista = await prisma.lista.findFirst({ where: { id, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const updated = await prisma.lista.update({ where: { id }, data: body })
    return reply.send({ lista: updated })
  })

  app.post('/listas/:id/resetar-erros', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload

    const lista = await prisma.lista.findFirst({ where: { id, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const { count } = await prisma.listaContato.updateMany({
      where: { listaId: id, statusWhatsapp: 'erro' },
      data: { statusWhatsapp: 'nao_validado' },
    })
    return reply.send({ resetados: count })
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
