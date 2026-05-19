import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'
import { getCredencial, getUazapiConnection } from '../lib/credencial'

async function sendViaWaha(accountId: string, telefone: string, mensagem: string, conexaoId?: string): Promise<boolean> {
  const conexao = conexaoId
    ? await prisma.whatsappConexao.findFirst({ where: { id: conexaoId, accountId } })
    : await prisma.whatsappConexao.findFirst({ where: { accountId, status: 'connected' }, orderBy: { createdAt: 'asc' } })

  if (!conexao?.instanceKey) return false

  const globalUrl = await prisma.configuracaoIntegracao.findUnique({ where: { chave: 'UAZAPI_BASE_URL' } })
  const cred = await prisma.credencial.findUnique({ where: { accountId_chave: { accountId, chave: 'UAZAPI_BASE_URL' } } })
  const baseUrl = globalUrl?.valor ?? (cred?.ativa ? decrypt(cred.valorCriptografado) : 'https://api.uazapi.com')

  const numero = telefone.replace(/\D/g, '')
  const phone = numero.startsWith('55') ? numero : `55${numero}`

  try {
    const res = await fetch(`${baseUrl}/message/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: conexao.instanceKey },
      body: JSON.stringify({ phone, body: mensagem }),
    })
    return res.ok
  } catch { return false }
}

function fallbackSuggestions(name: string, lastMsg: string) {
  const lc = lastMsg.toLowerCase()
  if (/pre[çc]o|valor|custo|quanto/.test(lc)) return [
    { text: `${name}, posso enviar mais detalhes sobre os valores. Qual o melhor horário para conversarmos?`, tone: 'formal' },
    { text: `Oi ${name}! 😊 Vou te passar os valores agora, pode me dar um minutinho?`, tone: 'amigavel' },
    { text: `Vou te enviar a tabela de preços. Prefere WhatsApp ou e-mail?`, tone: 'direto' },
  ]
  if (/agendar|hor[aá]rio|dispon[ií]vel|agenda/.test(lc)) return [
    { text: `${name}, tenho disponibilidade amanhã às 14h ou 16h. Qual prefere?`, tone: 'formal' },
    { text: `Show! 📅 Amanhã de tarde fica bem? 14h ou 16h?`, tone: 'amigavel' },
    { text: `Amanhã 14h ou 16h. Qual prefere?`, tone: 'direto' },
  ]
  if (/obrigado|agrade[çc]o|valeu/.test(lc)) return [
    { text: `Por nada, ${name}! Estamos à disposição.`, tone: 'formal' },
    { text: `Imagina! 😊 Qualquer coisa é só chamar.`, tone: 'amigavel' },
    { text: `Disponha! Qualquer dúvida é só falar.`, tone: 'direto' },
  ]
  return [
    { text: `${name}, como posso ajudá-lo com isso?`, tone: 'formal' },
    { text: `Oi ${name}! 😊 Me conta mais que te ajudo!`, tone: 'amigavel' },
    { text: `Entendido. O que precisa exatamente?`, tone: 'direto' },
  ]
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
    const { accountId } = request.user as JwtPayload
    const body = z.object({ contatoId: z.string().uuid(), ultimasMensagens: z.array(z.string()).optional() }).parse(request.body)

    const contato = await prisma.contato.findUnique({ where: { id: body.contatoId } })
    const contactName = contato?.contatoNome ?? contato?.nomeEmpresa ?? 'Cliente'

    // Buscar últimas 10 mensagens para contexto
    const mensagens = body.ultimasMensagens ?? (
      await prisma.interacao.findMany({
        where: { contatoId: body.contatoId, accountId },
        orderBy: { data: 'desc' },
        take: 10,
      })
    ).reverse().map((m) => `${m.direcao === 'enviado' ? 'Você' : contactName}: ${m.conteudo}`)

    const lastMsg = typeof mensagens[mensagens.length - 1] === 'string'
      ? mensagens[mensagens.length - 1] as string
      : ''

    const openaiKey = await getCredencial(accountId, 'OPENAI_API_KEY')
    if (!openaiKey) {
      return reply.send({ suggestions: fallbackSuggestions(contactName, lastMsg) })
    }

    const prompt = `Você é um assistente de vendas B2B via WhatsApp.
Com base no histórico abaixo, gere EXATAMENTE 3 sugestões de resposta: uma formal, uma amigável e uma direta.

Histórico:
${mensagens.slice(-6).join('\n')}

Responda APENAS em JSON válido (sem markdown):
[{"text":"...","tone":"formal"},{"text":"...","tone":"amigavel"},{"text":"...","tone":"direto"}]`

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 400, response_format: { type: 'json_object' } }),
      })
      if (res.ok) {
        const data = await res.json() as { choices?: { message?: { content?: string } }[] }
        const content = data.choices?.[0]?.message?.content ?? '[]'
        const parsed = JSON.parse(content)
        const suggestions = Array.isArray(parsed) ? parsed : parsed.suggestions ?? parsed.respostas ?? []
        if (suggestions.length > 0) return reply.send({ suggestions })
      }
    } catch { /* fallback */ }

    return reply.send({ suggestions: fallbackSuggestions(contactName, lastMsg) })
  })

  // Reactions em mensagens
  app.post('/chats/mensagens/:id/reactions', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { sub } = request.user as JwtPayload
    const body = z.object({ emoji: z.string().min(1) }).parse(request.body)

    const mensagem = await prisma.interacao.findUnique({ where: { id } })
    if (!mensagem) return reply.status(404).send({ message: 'Mensagem não encontrada.' })

    await prisma.interacaoReaction.deleteMany({ where: { interacaoId: id, userId: sub } })
    await prisma.interacaoReaction.create({ data: { interacaoId: id, userId: sub, emoji: body.emoji } })
    return reply.status(201).send({ ok: true })
  })

  // Substitui: analisar-sentimento-conversa
  app.post('/chats/analisar-sentimento', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({ contatoId: z.string().uuid() }).parse(request.body)

    const mensagens = await prisma.interacao.findMany({
      where: { contatoId: body.contatoId, accountId },
      orderBy: { data: 'desc' },
      take: 20,
      select: { direcao: true, conteudo: true },
    })
    if (mensagens.length === 0) return reply.send({ sentimento: 'neutro', score: 0 })

    const openaiKey = await getCredencial(accountId, 'OPENAI_API_KEY')
    if (!openaiKey) return reply.send({ sentimento: 'neutro', score: 0 })

    const historico = mensagens.reverse().map((m) => `${m.direcao === 'enviado' ? 'Vendedor' : 'Cliente'}: ${m.conteudo}`).join('\n')

    const prompt = `Analise o sentimento desta conversa de vendas e retorne JSON:
{"sentimento":"positivo"|"neutro"|"negativo","score":-1 a 1,"resumo":"1 frase"}

Conversa:
${historico}`

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 150, response_format: { type: 'json_object' } }),
      })
      if (res.ok) {
        const data = await res.json() as { choices?: { message?: { content?: string } }[] }
        const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
        return reply.send(parsed)
      }
    } catch { /* fallback */ }

    return reply.send({ sentimento: 'neutro', score: 0 })
  })

  // Substitui: sincronizar-chats — importa histórico UazAPI para o banco
  app.post('/chats/sincronizar', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({ conexaoId: z.string().uuid().optional() }).parse(request.body)

    const waha = await getUazapiConnection(accountId)
    if (!waha) return reply.status(400).send({ message: 'Nenhuma conexão WhatsApp ativa.' })

    const conexao = body.conexaoId
      ? await prisma.whatsappConexao.findFirst({ where: { id: body.conexaoId, accountId } })
      : await prisma.whatsappConexao.findFirst({ where: { accountId, status: 'connected' } })
    if (!conexao?.instanceKey) return reply.status(400).send({ message: 'Conexão não encontrada.' })

    const headers = { 'Content-Type': 'application/json', token: conexao.instanceKey }

    // 1. Buscar todos os chats individuais
    const chatRes = await fetch(`${waha.baseUrl}/chat/find`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sort: '-wa_lastMsgTimestamp', limit: 200, offset: 0, wa_isGroup: false }),
    })
    if (!chatRes.ok) return reply.status(502).send({ message: 'Erro ao buscar chats na UazAPI.' })

    const chatData = await chatRes.json() as { chats?: unknown[] } | unknown[]
    const chats: Record<string, unknown>[] = (Array.isArray(chatData) ? chatData : (chatData as { chats?: unknown[] }).chats ?? []) as Record<string, unknown>[]

    let syncedChats = 0
    let syncedMessages = 0

    for (const chat of chats) {
      const chatId = String(chat.wa_chatid ?? chat.wa_fastid ?? '')
      if (!chatId) continue

      const rawPhone = chatId.replace(/@s\.whatsapp\.net$/, '').replace(/@.*$/, '')
      if (!rawPhone || rawPhone.length < 8) continue

      const waName = String(chat.wa_contactName ?? chat.wa_name ?? chat.name ?? rawPhone)

      // Upsert contato
      let contato = await prisma.contato.findFirst({ where: { telefone: { in: [rawPhone, `55${rawPhone}`] } } })
      if (!contato) {
        contato = await prisma.contato.create({ data: { nomeEmpresa: waName, contatoNome: waName, telefone: rawPhone } }).catch(() => null as never)
      } else if (!contato.contatoNome) {
        await prisma.contato.update({ where: { id: contato.id }, data: { contatoNome: waName } })
      }
      if (!contato) continue

      // Buscar mensagens do chat
      const msgRes = await fetch(`${waha.baseUrl}/message/find`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chatid: chatId, limit: 50, offset: 0 }),
      })
      if (!msgRes.ok) continue

      const msgData = await msgRes.json() as { messages?: unknown[] } | unknown[]
      const messages: Record<string, unknown>[] = (Array.isArray(msgData) ? msgData : (msgData as { messages?: unknown[] }).messages ?? []) as Record<string, unknown>[]

      for (const msg of messages) {
        const msgId = String(msg.id ?? msg.messageid ?? msg.messageId ?? '')
        const fromMe = msg.fromMe === true
        const timestamp = Number(msg.timestamp ?? msg.messageTimestamp ?? 0)
        const msgDate = timestamp ? new Date(timestamp * 1000) : new Date()

        const msgContent = msg.message as Record<string, unknown> | undefined
        let mediaType = 'texto'
        if (msgContent?.imageMessage) mediaType = 'imagem'
        else if (msgContent?.audioMessage || msgContent?.pttMessage) mediaType = 'audio'
        else if (msgContent?.videoMessage) mediaType = 'video'
        else if (msgContent?.documentMessage) mediaType = 'documento'
        else if (msgContent?.stickerMessage) mediaType = 'sticker'
        else if (msgContent?.locationMessage) mediaType = 'localizacao'

        const texto = String(
          msg.text ?? msg.content ??
          (msgContent?.conversation) ??
          (msgContent?.extendedTextMessage as Record<string, unknown> | undefined)?.text ??
          `[${mediaType}]`
        )

        // Evitar duplicatas
        if (msgId) {
          const exists = await prisma.interacao.findFirst({ where: { externalId: msgId } })
          if (exists) continue
        }

        await prisma.interacao.create({
          data: {
            contatoId: contato.id,
            accountId,
            data: msgDate,
            direcao: fromMe ? 'enviado' : 'recebido',
            canal: 'whatsapp',
            conteudo: texto,
            mediaType,
            externalId: msgId || undefined,
          },
        }).catch(() => null)
        syncedMessages++
      }

      syncedChats++
    }

    return reply.send({ syncedChats, syncedMessages })
  })

  // SSE — polling de mensagens novas (substitui Supabase Realtime)
  app.get('/chats/stream/:contatoId', { preValidation: [requireAuth] }, async (request, reply) => {
    const { contatoId } = z.object({ contatoId: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    let lastChecked = new Date()
    const keepAlive = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000)

    const poll = setInterval(async () => {
      try {
        const novas = await prisma.interacao.findMany({
          where: { contatoId, accountId, data: { gt: lastChecked } },
          orderBy: { data: 'asc' },
        })
        if (novas.length > 0) {
          lastChecked = novas[novas.length - 1].data
          send('mensagens', novas)
        }
      } catch { /* connection may have closed */ }
    }, 2000)

    request.raw.on('close', () => {
      clearInterval(keepAlive)
      clearInterval(poll)
    })
  })
}
