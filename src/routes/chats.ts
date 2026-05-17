import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'

async function sendViaWaha(accountId: string, telefone: string, mensagem: string, conexaoId?: string): Promise<boolean> {
  const conexao = conexaoId
    ? await prisma.whatsappConexao.findFirst({ where: { id: conexaoId, accountId } })
    : await prisma.whatsappConexao.findFirst({ where: { accountId, status: 'connected' }, orderBy: { createdAt: 'asc' } })

  if (!conexao?.instanceKey) return false

  const cred = await prisma.credencial.findUnique({ where: { accountId_chave: { accountId, chave: 'UAZAPI_BASE_URL' } } })
  const baseUrl = cred?.ativa ? decrypt(cred.valorCriptografado) : 'https://api.uazapi.com'

  const numero = telefone.replace(/\D/g, '')
  const phone = numero.startsWith('55') ? numero : `55${numero}`

  try {
    const res = await fetch(`${baseUrl}/v1/messages/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'instance-key': conexao.instanceKey },
      body: JSON.stringify({ phone, body: mensagem }),
    })
    return res.ok
  } catch { return false }
}

export async function chatsRoutes(app: FastifyInstance) {
  app.get('/chats/conversas', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const query = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(30),
    }).parse(request.query)

    const skip = (query.page - 1) * query.limit
    const conversas = await prisma.contato.findMany({
      where: { interacoes: { some: { accountId } } },
      skip,
      take: query.limit,
      include: {
        interacoes: {
          where: { accountId },
          orderBy: { data: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    })
    return reply.send({ conversas })
  })

  app.get('/chats/mensagens/:contatoId', { preValidation: [requireAuth] }, async (request, reply) => {
    const { contatoId } = z.object({ contatoId: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const query = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(request.query)

    const skip = (query.page - 1) * query.limit
    const mensagens = await prisma.interacao.findMany({
      where: { contatoId, accountId },
      orderBy: { data: 'asc' },
      skip,
      take: query.limit,
    })
    return reply.send({ mensagens })
  })

  // Substitui: enviar-mensagem-chat
  app.post('/chats/mensagens', { preValidation: [requireAuth] }, async (request, reply) => {
    const { sub: userId, accountId } = request.user as JwtPayload
    const body = z.object({
      contatoId: z.string().uuid(),
      conteudo: z.string().min(1),
      conexaoId: z.string().uuid().optional(),
      mediaUrl: z.string().url().optional(),
      mediaType: z.string().optional(),
    }).parse(request.body)

    const contato = await prisma.contato.findUnique({ where: { id: body.contatoId } })
    if (!contato) return reply.status(404).send({ message: 'Contato não encontrado.' })

    const mensagem = await prisma.interacao.create({
      data: {
        contatoId: body.contatoId,
        accountId,
        userId,
        direcao: 'enviado',
        canal: 'whatsapp',
        conteudo: body.conteudo,
        mediaUrl: body.mediaUrl,
      },
    })

    // Enviar via WhatsApp (não bloqueia a resposta se falhar)
    if (contato.telefone) {
      sendViaWaha(accountId, contato.telefone, body.conteudo, body.conexaoId).catch(() => {})
    }

    return reply.status(201).send({ mensagem })
  })

  // Substitui: editar-mensagem-chat
  app.patch('/chats/mensagens/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const body = z.object({ conteudo: z.string().min(1) }).parse(request.body)

    const mensagem = await prisma.interacao.findFirst({ where: { id, accountId } })
    if (!mensagem) return reply.status(404).send({ message: 'Mensagem não encontrada.' })

    // Salva histórico antes de editar
    await prisma.interacaoHistoricoEdicao.create({
      data: { interacaoId: id, conteudoAnterior: mensagem.conteudo },
    })
    const updated = await prisma.interacao.update({ where: { id }, data: { conteudo: body.conteudo, editado: true } })
    return reply.send({ mensagem: updated })
  })

  // Substitui: sugerir-respostas-chat
  app.post('/chats/sugerir-respostas', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({ contatoId: z.string().uuid(), ultimasMensagens: z.array(z.string()).optional() }).parse(request.body)
    // TODO: chamar OpenAI para sugestões
    return reply.send({ sugestoes: [], message: 'TODO: sugestões com IA' })
  })

  // Substitui: analisar-sentimento-conversa
  app.post('/chats/analisar-sentimento', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({ contatoId: z.string().uuid() }).parse(request.body)
    // TODO: analisar sentimento com IA
    return reply.send({ sentimento: null, message: 'TODO: análise de sentimento' })
  })

  // Substitui: sincronizar-chats
  app.post('/chats/sincronizar', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({ conexaoId: z.string().uuid() }).parse(request.body)
    // TODO: sincronizar chats via UazAPI
    return reply.send({ sincronizados: 0, message: 'TODO: sincronização de chats' })
  })

  // SSE — substitui Supabase Realtime para ChatWindow e ConversasList
  app.get('/chats/stream/:contatoId', { preValidation: [requireAuth] }, async (request, reply) => {
    const { contatoId } = z.object({ contatoId: z.string().uuid() }).parse(request.params)
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const keepAlive = setInterval(() => {
      reply.raw.write(': keepalive\n\n')
    }, 15000)

    request.raw.on('close', () => clearInterval(keepAlive))
    // TODO: implementar polling de mensagens novas e emitir events SSE
  })
}
