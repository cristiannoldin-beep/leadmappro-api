import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { requireAdmin } from '../lib/auth'
import { prisma } from '../lib/prisma'

export async function adminRoutes(app: FastifyInstance) {
  // ── Accounts list (enriched) ──────────────────────────────────────────────
  app.get('/admin/accounts', { preValidation: [requireAdmin] }, async (request, reply) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(50) }).parse(request.query)
    const skip = (query.page - 1) * query.limit

    const [accounts, total] = await Promise.all([
      prisma.account.findMany({
        skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          plan: { select: { id: true, name: true, price: true } },
          members: {
            where: { role: 'owner' },
            take: 1,
            include: { user: { select: { email: true, celular: true, nomeCompleto: true } } },
          },
          _count: {
            select: {
              listas: true,
              campanhas: true,
            },
          },
        },
      }),
      prisma.account.count(),
    ])

    // leads count per account (count contacts across all listas)
    const accountIds = accounts.map((a) => a.id)
    const leadsCounts = await prisma.listaContato.groupBy({
      by: ['listaId'],
      where: { lista: { accountId: { in: accountIds } } },
      _count: { id: true },
    })

    const listaAccountMap = await prisma.lista.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true, accountId: true },
    })

    const leadsPerAccount: Record<string, number> = {}
    for (const la of listaAccountMap) {
      const count = leadsCounts.find((lc) => lc.listaId === la.id)?._count.id ?? 0
      leadsPerAccount[la.accountId] = (leadsPerAccount[la.accountId] ?? 0) + count
    }

    const enriched = accounts.map((acc) => ({
      id: acc.id,
      name: acc.name,
      slug: acc.slug,
      status: acc.status,
      planId: acc.planId,
      plan: acc.plan,
      trialEndsAt: acc.trialEndsAt,
      createdAt: acc.createdAt,
      owner: acc.members[0]?.user ?? null,
      leadsCount: leadsPerAccount[acc.id] ?? 0,
      listasCount: acc._count.listas,
      campanhasCount: acc._count.campanhas,
    }))

    return reply.send({ accounts: enriched, total })
  })

  // ── Update account (status + plan) ───────────────────────────────────────
  app.patch('/admin/accounts/:id', { preValidation: [requireAdmin] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      status: z.string().optional(),
      planId: z.string().uuid().nullable().optional(),
    }).parse(request.body)

    const account = await prisma.account.update({ where: { id }, data: body })
    return reply.send({ account })
  })

  // ── Delete account ────────────────────────────────────────────────────────
  app.delete('/admin/accounts/:id', { preValidation: [requireAdmin] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await prisma.account.delete({ where: { id } })
    return reply.status(204).send()
  })

  // ── Create client (manual onboarding) ────────────────────────────────────
  app.post('/admin/clients', { preValidation: [requireAdmin] }, async (request, reply) => {
    const body = z.object({
      nomeCompleto: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(6),
      celular: z.string().optional(),
      planId: z.string().uuid().optional(),
    }).parse(request.body)

    const existing = await prisma.profile.findUnique({ where: { email: body.email } })
    if (existing) return reply.status(409).send({ message: 'Este email já está cadastrado.' })

    const hash = await bcrypt.hash(body.password, 12)

    await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          name: body.nomeCompleto,
          slug: `${body.email.split('@')[0]}-${Date.now()}`,
          status: 'active',
          planId: body.planId ?? null,
        },
      })
      const profile = await tx.profile.create({
        data: {
          email: body.email,
          password: hash,
          nomeCompleto: body.nomeCompleto,
          celular: body.celular,
          role: 'user',
        },
      })
      await tx.accountMember.create({ data: { accountId: account.id, userId: profile.id, role: 'owner' } })
    })

    return reply.status(201).send({ message: 'Cliente criado com sucesso.' })
  })

  // ── Plans ─────────────────────────────────────────────────────────────────
  app.get('/admin/plans', { preValidation: [requireAdmin] }, async (_request, reply) => {
    const plans = await prisma.plan.findMany({ orderBy: { price: 'asc' } })
    return reply.send({ plans })
  })

  app.patch('/admin/plans/:id', { preValidation: [requireAdmin] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      name: z.string().optional(),
      price: z.number().optional(),
      limits: z.any().optional(),
    }).parse(request.body)

    const plan = await prisma.plan.update({ where: { id }, data: body as { name?: string; price?: number; limits?: object } })
    return reply.send({ plan })
  })

  // ── Stats for dashboard ───────────────────────────────────────────────────
  app.get('/admin/stats', { preValidation: [requireAdmin] }, async (_request, reply) => {
    const [total, active] = await Promise.all([
      prisma.account.count(),
      prisma.account.count({ where: { status: { in: ['active', 'trialing'] } } }),
    ])
    return reply.send({ total, active, openaiCost: 0, mapsCost: 0 })
  })

  // ── Listas de uma conta específica ───────────────────────────────────────
  app.get('/admin/accounts/:id/listas', { preValidation: [requireAdmin] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const listas = await prisma.lista.findMany({
      where: { accountId: id },
      orderBy: { dataCriacao: 'desc' },
      take: 200,
      include: { _count: { select: { listaContatos: true } } },
    })
    return reply.send({
      listas: listas.map((l) => ({
        id: l.id,
        nome: l.nome,
        origem: l.origem,
        segmento: l.segmento,
        cidade: l.cidade,
        estado: l.estado,
        dataCriacao: l.dataCriacao,
        totalContatos: l._count.listaContatos,
      })),
    })
  })

  // ── Contatos de uma lista específica ────────────────────────────────────
  app.get('/admin/accounts/:accountId/listas/:listaId/contatos', { preValidation: [requireAdmin] }, async (request, reply) => {
    const { accountId, listaId } = z.object({
      accountId: z.string().uuid(),
      listaId: z.string().uuid(),
    }).parse(request.params)
    const { page, limit } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(request.query)

    const lista = await prisma.lista.findFirst({ where: { id: listaId, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada' })

    const skip = (page - 1) * limit
    const [listaContatos, total] = await Promise.all([
      prisma.listaContato.findMany({
        where: { listaId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { contato: { select: { nomeEmpresa: true, telefone: true, cidade: true, estado: true, atividade: true, website: true } } },
      }),
      prisma.listaContato.count({ where: { listaId } }),
    ])

    return reply.send({
      contatos: listaContatos.map((lc) => ({
        id: lc.id,
        nomeEmpresa: lc.contato.nomeEmpresa,
        telefone: lc.contato.telefone,
        cidade: lc.contato.cidade,
        estado: lc.contato.estado,
        atividade: lc.contato.atividade,
        website: lc.contato.website,
        statusWhatsapp: lc.statusWhatsapp,
        statusNaLista: lc.statusNaLista,
        mensagemEnviada: lc.mensagemEnviada,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    })
  })

  // ── Expirar trials vencidos manualmente ──────────────────────────────────
  app.post('/admin/expirar-trials', { preValidation: [requireAdmin] }, async (_request, reply) => {
    const { count } = await prisma.account.updateMany({
      where: { status: 'trialing', trialEndsAt: { lt: new Date() } },
      data: { status: 'suspended' },
    })
    return reply.send({ suspensos: count, message: `${count} conta(s) com trial expirado foram suspensas.` })
  })

  // ── Logs (audit) ──────────────────────────────────────────────────────────
  app.get('/admin/logs', { preValidation: [requireAdmin] }, async (request, reply) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(50) }).parse(request.query)
    const skip = (query.page - 1) * query.limit
    return reply.send({ logs: [], total: 0, skip })
  })

  // ── Infra stats ───────────────────────────────────────────────────────────
  app.get('/admin/infra', { preValidation: [requireAdmin] }, async (_request, reply) => {
    const [profiles, accounts, conexoes] = await Promise.all([
      prisma.profile.count(),
      prisma.account.count(),
      prisma.whatsappConexao.count(),
    ])
    return reply.send({ stats: { profiles, accounts, conexoes } })
  })

  // ── Credenciais (configuracoes_integracoes) ───────────────────────────────
  app.get('/admin/credenciais/:chave', { preValidation: [requireAdmin] }, async (request, reply) => {
    const { chave } = z.object({ chave: z.string().min(1) }).parse(request.params)
    const config = await prisma.configuracaoIntegracao.findUnique({ where: { chave } })
    return reply.send({ configured: !!(config?.valor), statusTeste: config?.statusTeste ?? 'nao_testado' })
  })

  app.post('/admin/credenciais', { preValidation: [requireAdmin] }, async (request, reply) => {
    const body = z.object({
      chave: z.string().min(1),
      valor: z.string().min(1),
    }).parse(request.body)

    await prisma.configuracaoIntegracao.upsert({
      where: { chave: body.chave },
      update: { valor: body.valor, atualizadoEm: new Date() },
      create: { chave: body.chave, valor: body.valor },
    })
    return reply.send({ success: true })
  })

  app.post('/admin/credenciais/testar', { preValidation: [requireAdmin] }, async (request, reply) => {
    const { tipo } = z.object({ tipo: z.enum(['google_maps', 'openai']) }).parse(request.body)
    const chave = tipo === 'google_maps' ? 'GOOGLE_MAPS_API_KEY' : 'OPENAI_API_KEY'

    const config = await prisma.configuracaoIntegracao.findUnique({ where: { chave } })
    if (!config?.valor) return reply.status(400).send({ sucesso: false, mensagem: 'Chave não configurada.' })

    const key = config.valor
    let sucesso = false
    let mensagem = ''

    try {
      if (tipo === 'google_maps') {
        const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.displayName' },
          body: JSON.stringify({ textQuery: 'restaurante', languageCode: 'pt-BR', maxResultCount: 1 }),
        })
        const data = await res.json() as { places?: unknown[]; error?: { message: string } }
        sucesso = res.ok
        mensagem = sucesso ? 'Google Maps API funcionando corretamente!' : `Erro: ${data.error?.message ?? 'Chave inválida'}`
      } else {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        })
        const data = await res.json() as { error?: { message: string } }
        sucesso = res.ok
        mensagem = sucesso ? 'OpenAI API key válida e funcionando!' : `Erro: ${data.error?.message ?? 'Chave inválida'}`
      }
    } catch (err: unknown) {
      mensagem = `Falha de rede: ${err instanceof Error ? err.message : 'erro desconhecido'}`
    }

    await prisma.configuracaoIntegracao.update({
      where: { chave },
      data: { statusTeste: sucesso ? 'sucesso' : 'erro' },
    })

    return reply.send({ sucesso, mensagem })
  })
}
