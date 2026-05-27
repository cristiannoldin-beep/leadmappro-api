import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, requireActiveAccount, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'

// ── Helpers ───────────────────────────────────────────────────────────────────

function processSpintax(text: string): string {
  return text.replace(/\{([^{}]+)\}/g, (_, options) => {
    const parts = options.split('|')
    return parts[Math.floor(Math.random() * parts.length)].trim()
  })
}

function personalizeMessage(template: string, contato: { nomeEmpresa: string; cidade?: string | null; estado?: string | null }): string {
  return template
    .replace(/\{nome_empresa\}/gi, contato.nomeEmpresa)
    .replace(/\{cidade\}/gi, contato.cidade ?? '')
    .replace(/\{estado\}/gi, contato.estado ?? '')
}

function isWithinHorario(horarioInicio: string, horarioFim: string): boolean {
  const now = new Date()
  const [hiH, hiM] = horarioInicio.split(':').map(Number)
  const [hfH, hfM] = horarioFim.split(':').map(Number)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const inicioMinutes = hiH * 60 + hiM
  const fimMinutes = hfH * 60 + hfM
  return nowMinutes >= inicioMinutes && nowMinutes <= fimMinutes
}

async function getCredencial(accountId: string, chave: string): Promise<string | null> {
  const cred = await prisma.credencial.findUnique({
    where: { accountId_chave: { accountId, chave } },
  })
  if (!cred?.ativa) return null
  return decrypt(cred.valorCriptografado)
}

async function sendWhatsappMessage(waha: { baseUrl: string; instanceKey: string }, phone: string, message: string): Promise<boolean> {
  try {
    const numero = phone.startsWith('55') ? phone : `55${phone}`
    const res = await fetch(`${waha.baseUrl}/v1/messages/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'instance-key': waha.instanceKey },
      body: JSON.stringify({ phone: numero, body: message }),
    })
    return res.ok
  } catch { return false }
}

async function dispararCampanha(campanhaId: string): Promise<{ enviados: number; erros: number; ignorados: number }> {
  const campanha = await prisma.campanha.findUnique({
    where: { id: campanhaId },
    include: { conexao: true },
  })
  if (!campanha || !campanha.ativo) return { enviados: 0, erros: 0, ignorados: 0 }

  if (!isWithinHorario(campanha.horarioInicio, campanha.horarioFim)) {
    return { enviados: 0, erros: 0, ignorados: 0 }
  }

  // Verificar conexão WAHA
  const conexao = campanha.conexao ?? await prisma.whatsappConexao.findFirst({
    where: { accountId: campanha.accountId, status: 'connected' },
    orderBy: { createdAt: 'asc' },
  })
  if (!conexao) return { enviados: 0, erros: 0, ignorados: 0 }

  const baseUrl = (await getCredencial(campanha.accountId, 'UAZAPI_BASE_URL')) ?? 'https://api.uazapi.com'
  const waha = { baseUrl, instanceKey: conexao.instanceKey ?? '' }

  // Contar envios de hoje
  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const enviadosHoje = await prisma.campanhaContato.count({
    where: {
      campanhaId,
      etapa: { not: 'nao_abordado' },
      dataUltimaAcao: { gte: hoje },
    },
  })

  const restante = campanha.limiteEnviosDia - enviadosHoje
  if (restante <= 0) return { enviados: 0, erros: 0, ignorados: 0 }

  // Buscar próximos contatos a disparar
  const pendentes = await prisma.campanhaContato.findMany({
    where: { campanhaId, etapa: 'nao_abordado' },
    include: { contato: { select: { nomeEmpresa: true, telefone: true, cidade: true, estado: true } } },
    take: restante,
    orderBy: { createdAt: 'asc' },
  })

  let enviados = 0, erros = 0, ignorados = 0

  for (const cc of pendentes) {
    const telefone = cc.contato.telefone?.replace(/\D/g, '') ?? ''
    if (telefone.length < 10) {
      await prisma.campanhaContato.update({ where: { id: cc.id }, data: { etapa: 'finalizado', resultado: 'erro_numero', dataUltimaAcao: new Date() } })
      ignorados++
      continue
    }

    const msgSpintax = processSpintax(campanha.mensagemBase)
    const msgFinal = personalizeMessage(msgSpintax, cc.contato)

    const ok = await sendWhatsappMessage(waha, telefone, msgFinal)

    await prisma.campanhaContato.update({
      where: { id: cc.id },
      data: {
        etapa: 'primeira_msg',
        resultado: ok ? null : 'sem_resposta',
        dataUltimaAcao: new Date(),
      },
    })

    // Marcar mensagem enviada no ListaContato se possível
    await prisma.listaContato.updateMany({
      where: { listaId: campanha.listaId, contatoId: cc.contatoId },
      data: { mensagemEnviada: true },
    })

    if (ok) enviados++; else erros++

    if (cc !== pendentes[pendentes.length - 1]) {
      await new Promise(r => setTimeout(r, campanha.delayMinutos * 60_000))
    }
  }

  return { enviados, erros, ignorados }
}

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

  app.post('/campanhas', { preValidation: [requireActiveAccount] }, async (request, reply) => {
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
        lista: { select: { nome: true, id: true } },
        conexao: { select: { apelido: true, numeroTelefone: true } },
      },
    })
    if (!campanha) return reply.status(404).send({ message: 'Campanha não encontrada.' })

    const [total, enviados, pendentes] = await Promise.all([
      prisma.campanhaContato.count({ where: { campanhaId: id } }),
      prisma.campanhaContato.count({ where: { campanhaId: id, etapa: { not: 'nao_abordado' } } }),
      prisma.campanhaContato.count({ where: { campanhaId: id, etapa: 'nao_abordado' } }),
    ])

    return reply.send({ campanha: { ...campanha, totalContatos: total, totalEnviados: enviados, totalPendentes: pendentes } })
  })

  // Iniciar campanha — copia contatos válidos da lista para campanha_contatos
  app.post('/campanhas/:id/iniciar', { preValidation: [requireActiveAccount] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const campanha = await prisma.campanha.findFirst({ where: { id, accountId } })
    if (!campanha) return reply.status(404).send({ message: 'Campanha não encontrada.' })

    // Busca contatos válidos (WhatsApp válido) da lista que ainda não estão na campanha
    const listaContatos = await prisma.listaContato.findMany({
      where: {
        listaId: campanha.listaId,
        statusWhatsapp: 'valido',
        contato: { id: { notIn: await prisma.campanhaContato.findMany({ where: { campanhaId: id }, select: { contatoId: true } }).then(r => r.map(x => x.contatoId)) } },
      },
      select: { contatoId: true },
    })

    if (listaContatos.length === 0) {
      return reply.send({ inseridos: 0, message: 'Nenhum contato novo com WhatsApp válido para adicionar.' })
    }

    await prisma.campanhaContato.createMany({
      data: listaContatos.map(lc => ({ campanhaId: id, contatoId: lc.contatoId })),
      skipDuplicates: true,
    })

    return reply.send({ inseridos: listaContatos.length })
  })

  // Contatos da campanha com paginação
  app.get('/campanhas/:id/contatos', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const { page = '1', limit = '50' } = request.query as Record<string, string>

    const campanha = await prisma.campanha.findFirst({ where: { id, accountId } })
    if (!campanha) return reply.status(404).send({ message: 'Campanha não encontrada.' })

    const skip = (Number(page) - 1) * Number(limit)
    const [campanhaContatos, total] = await Promise.all([
      prisma.campanhaContato.findMany({
        where: { campanhaId: id },
        include: { contato: { select: { nomeEmpresa: true, telefone: true, cidade: true, estado: true } } },
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'asc' },
      }),
      prisma.campanhaContato.count({ where: { campanhaId: id } }),
    ])

    const contatos = campanhaContatos.map(cc => ({
      id: cc.id,
      contatoId: cc.contatoId,
      nomeEmpresa: cc.contato.nomeEmpresa,
      telefone: cc.contato.telefone,
      cidade: cc.contato.cidade,
      estado: cc.contato.estado,
      etapa: cc.etapa,
      resultado: cc.resultado,
      dataUltimaAcao: cc.dataUltimaAcao,
    }))

    return reply.send({ contatos, total, page: Number(page), limit: Number(limit) })
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

  // Disparo manual — autenticado, para testes ou uso pontual
  app.post('/campanhas/:id/disparar', { preValidation: [requireActiveAccount] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const campanha = await prisma.campanha.findFirst({ where: { id, accountId } })
    if (!campanha) return reply.status(404).send({ message: 'Campanha não encontrada.' })
    const result = await dispararCampanha(id)
    return reply.send(result)
  })

  // Cron endpoint — chamado pelo Coolify Scheduler (sem auth de usuário, usa CRON_SECRET)
  app.post('/campanhas/cron/disparar', async (request, reply) => {
    const cronSecret = request.headers['x-cron-secret']
    if (cronSecret !== process.env.CRON_SECRET) {
      return reply.status(401).send({ message: 'Não autorizado.' })
    }

    // Dispara todas as campanhas ativas
    const campanhas = await prisma.campanha.findMany({ where: { ativo: true } })
    const resultados = await Promise.allSettled(campanhas.map(c => dispararCampanha(c.id)))

    const totais = resultados.reduce((acc, r) => {
      if (r.status === 'fulfilled') {
        acc.enviados += r.value.enviados
        acc.erros += r.value.erros
      }
      return acc
    }, { enviados: 0, erros: 0 })

    return reply.send({ campanhasProcessadas: campanhas.length, ...totais })
  })
}
