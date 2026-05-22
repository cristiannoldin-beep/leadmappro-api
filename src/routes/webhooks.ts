import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'

interface UazApiEvent {
  event: string
  instance?: string
  instanceKey?: string
  data?: {
    state?: string
    key?: { remoteJid?: string; fromMe?: boolean; id?: string }
    message?: { conversation?: string; extendedTextMessage?: { text?: string }; imageMessage?: { caption?: string }; videoMessage?: { caption?: string } }
    messageTimestamp?: number
    pushName?: string
    phoneNumber?: string
    profilePicUrl?: string
  }
}

function extractMessageText(data: UazApiEvent['data']): string {
  const msg = data?.message
  if (!msg) return ''
  return msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? ''
}

export async function webhooksRoutes(app: FastifyInstance) {
  // UazAPI webhook — sem autenticação por header (UazAPI usa URL secreta)
  app.post('/webhooks/whatsapp', async (request, reply) => {
    const payload = request.body as UazApiEvent

    // Evento de atualização de status de conexão (UazAPI GO V2 pode enviar variações)
    const isConnectionEvent = ['connection.update', 'ConnectionUpdate', 'connection_update'].includes(payload.event)
    if (isConnectionEvent) {
      const instanceName = payload.instance ?? ''
      const rawState = (payload.data?.state ?? '').toLowerCase()

      const status = rawState === 'open' || rawState === 'connected' ? 'connected'
        : rawState === 'close' || rawState === 'closed' || rawState === 'disconnected' ? 'disconnected'
        : rawState === 'connecting' ? 'connecting'
        : rawState || 'disconnected'

      if (instanceName) {
        await prisma.whatsappConexao.updateMany({
          where: { instanceName },
          data: { status, updatedAt: new Date() },
        })

        // Se conectou, buscar número do telefone
        if (status === 'connected' && payload.data?.phoneNumber) {
          await prisma.whatsappConexao.updateMany({
            where: { instanceName },
            data: { numeroTelefone: payload.data.phoneNumber },
          })
        }
      }
      return reply.status(200).send({ received: true })
    }

    // Evento de mensagem recebida (UazAPI GO V2: messages.upsert ou MessagesUpsert)
    if (['messages.upsert', 'MessagesUpsert', 'messages_upsert'].includes(payload.event)) {
      const key = payload.data?.key
      const fromMe = key?.fromMe ?? false
      if (fromMe) return reply.status(200).send({ received: true }) // Ignora mensagens enviadas

      const remoteJid = key?.remoteJid ?? ''
      const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '')
      if (!telefone) return reply.status(200).send({ received: true })

      const texto = extractMessageText(payload.data)
      if (!texto) return reply.status(200).send({ received: true })

      const instanceName = payload.instance ?? ''

      // Encontrar a conta dona desta instância
      const conexao = await prisma.whatsappConexao.findFirst({ where: { instanceName } })
      if (!conexao) return reply.status(200).send({ received: true })

      // Criar ou encontrar contato
      const telefoneFormatado = telefone.startsWith('55') ? telefone : `55${telefone}`
      let contato = await prisma.contato.findFirst({ where: { telefone: { in: [telefone, telefoneFormatado] } } })
      if (!contato) {
        contato = await prisma.contato.create({
          data: {
            nomeEmpresa: payload.data?.pushName ?? 'Contato WhatsApp',
            telefone: telefoneFormatado,
          },
        })
      }

      // Registrar a interação recebida
      await prisma.interacao.create({
        data: {
          contatoId: contato.id,
          accountId: conexao.accountId,
          direcao: 'recebido',
          canal: 'whatsapp',
          conteudo: texto,
          externalId: key?.id,
        },
      })

      return reply.status(200).send({ received: true })
    }

    return reply.status(200).send({ received: true })
  })

  // Evolution API webhook
  app.post('/webhooks/evolution', async (request, reply) => {
    const payload = request.body as {
      event?: string
      instance?: string
      data?: {
        state?: string
        wuid?: string
        profileName?: string
        key?: { remoteJid?: string; fromMe?: boolean; id?: string }
        message?: { conversation?: string; extendedTextMessage?: { text?: string }; imageMessage?: { caption?: string }; videoMessage?: { caption?: string } }
        messageType?: string
        messageTimestamp?: number
        pushName?: string
      }
    }

    const event = payload.event ?? ''
    const instanceName = payload.instance ?? ''

    // connection.update → atualiza status no banco
    if (['connection.update', 'CONNECTION_UPDATE'].includes(event)) {
      const rawState = (payload.data?.state ?? '').toLowerCase()
      const status = rawState === 'open' || rawState === 'connected' ? 'connected'
        : rawState === 'close' || rawState === 'closed' || rawState === 'disconnected' ? 'disconnected'
        : rawState === 'connecting' ? 'connecting'
        : rawState || 'disconnected'

      if (instanceName) {
        await prisma.whatsappConexao.updateMany({
          where: { instanceName },
          data: { status, updatedAt: new Date() },
        })

        // Extrair e salvar número quando conectado (Evolution envia wuid: "5511999@s.whatsapp.net")
        if (status === 'connected' && payload.data?.wuid) {
          const numeroTelefone = payload.data.wuid.replace('@s.whatsapp.net', '').replace('@c.us', '')
          if (numeroTelefone) {
            await prisma.whatsappConexao.updateMany({
              where: { instanceName },
              data: { numeroTelefone },
            })
          }
        }
      }
      return reply.status(200).send({ received: true })
    }

    // messages.upsert → registrar mensagem recebida
    if (['messages.upsert', 'MESSAGES_UPSERT'].includes(event)) {
      const key = payload.data?.key
      const fromMe = key?.fromMe ?? false
      if (fromMe) return reply.status(200).send({ received: true })

      const remoteJid = key?.remoteJid ?? ''
      const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '')
      if (!telefone) return reply.status(200).send({ received: true })

      const msg = payload.data?.message
      const texto = msg?.conversation ?? msg?.extendedTextMessage?.text ?? msg?.imageMessage?.caption ?? msg?.videoMessage?.caption ?? ''
      if (!texto) return reply.status(200).send({ received: true })

      const conexao = await prisma.whatsappConexao.findFirst({ where: { instanceName } })
      if (!conexao) return reply.status(200).send({ received: true })

      const telefoneFormatado = telefone.startsWith('55') ? telefone : `55${telefone}`
      let contato = await prisma.contato.findFirst({ where: { telefone: { in: [telefone, telefoneFormatado] } } })
      if (!contato) {
        contato = await prisma.contato.create({
          data: {
            nomeEmpresa: payload.data?.pushName ?? 'Contato WhatsApp',
            telefone: telefoneFormatado,
          },
        })
      }

      await prisma.interacao.create({
        data: {
          contatoId: contato.id,
          accountId: conexao.accountId,
          direcao: 'recebido',
          canal: 'whatsapp',
          conteudo: texto,
          externalId: key?.id,
        },
      })
    }

    return reply.status(200).send({ received: true })
  })

  // ── Meta Webhook ───────────────────────────────────────────────────────────
  app.get('/webhooks/meta', async (request, reply) => {
    const query = request.query as Record<string, string>
    const mode = query['hub.mode']
    const token = query['hub.verify_token']
    const challenge = query['hub.challenge']

    if (mode === 'subscribe' && token === (process.env.META_WEBHOOK_VERIFY_TOKEN ?? 'leadmappro_webhook_secret_2026')) {
      return reply.status(200).send(challenge)
    }
    return reply.status(403).send({ message: 'Verificação falhou.' })
  })

  app.post('/webhooks/meta', async (request, reply) => {
    try {
      const payload = request.body as {
        object?: string
        entry?: Array<{
          changes?: Array<{
            value?: {
              messages?: Array<{
                from?: string
                text?: { body?: string }
                type?: string
                id?: string
                timestamp?: string
              }>
              metadata?: { phone_number_id?: string }
            }
          }>
        }>
      }

      if (payload.object !== 'whatsapp_business_account') {
        return reply.status(200).send('EVENT_RECEIVED')
      }

      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value
          for (const msg of value?.messages ?? []) {
            if (msg.type !== 'text' || !msg.text?.body || !msg.from) continue

            const phoneNumberId = value?.metadata?.phone_number_id
            const conexao = phoneNumberId
              ? await prisma.whatsappConexao.findFirst({ where: { instanceName: phoneNumberId } })
              : null
            if (!conexao) continue

            const telefone = msg.from.startsWith('55') ? msg.from : `55${msg.from}`
            let contato = await prisma.contato.findFirst({ where: { telefone: { in: [msg.from, telefone] } } })
            if (!contato) {
              contato = await prisma.contato.create({
                data: { nomeEmpresa: telefone, telefone },
              })
            }

            const msgDate = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date()
            if (msg.id) {
              const exists = await prisma.interacao.findFirst({ where: { externalId: msg.id } })
              if (exists) continue
            }
            await prisma.interacao.create({
              data: {
                contatoId: contato.id,
                accountId: conexao.accountId,
                direcao: 'recebido',
                canal: 'whatsapp',
                conteudo: msg.text.body,
                data: msgDate,
                externalId: msg.id,
              },
            })
          }
        }
      }
    } catch { /* não bloquear a resposta 200 */ }

    return reply.status(200).send('EVENT_RECEIVED')
  })

  // ── Stripe Webhook ─────────────────────────────────────────────────────────
  app.post('/webhooks/stripe', { config: { rawBody: true } }, async (request, reply) => {
    const sig = request.headers['stripe-signature'] as string
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    const stripeKey = process.env.STRIPE_SECRET_KEY

    if (!stripeKey) return reply.status(200).send({ received: true })

    let event: { type: string; data: { object: Record<string, unknown> } }
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody?.toString() ?? JSON.stringify(request.body)

    if (webhookSecret && sig) {
      // Verificação manual da assinatura HMAC-SHA256
      const crypto = await import('crypto')
      const parts = sig.split(',').reduce<Record<string, string>>((acc, p) => {
        const [k, v] = p.split('=')
        acc[k] = v
        return acc
      }, {})
      const timestamp = parts['t']
      const expectedSig = crypto.createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex')
      if (`v1=${expectedSig}` !== parts['v1']) {
        return reply.status(400).send({ message: 'Assinatura inválida.' })
      }
    }

    try { event = JSON.parse(rawBody) } catch {
      return reply.status(400).send({ message: 'Payload inválido.' })
    }

    const obj = event.data.object

    if (event.type === 'checkout.session.completed') {
      const accountId = (obj.metadata as Record<string, string> | undefined)?.account_id
      const planId = (obj.metadata as Record<string, string> | undefined)?.plan_id
      if (accountId) {
        await prisma.account.update({ where: { id: accountId }, data: { status: 'active', ...(planId ? { planId } : {}) } }).catch(() => null)
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const accountId = (obj.metadata as Record<string, string> | undefined)?.account_id
      if (accountId) {
        await prisma.account.update({ where: { id: accountId }, data: { status: 'past_due' } }).catch(() => null)
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const accountId = (obj.metadata as Record<string, string> | undefined)?.account_id
      if (accountId) {
        await prisma.account.update({ where: { id: accountId }, data: { status: 'suspended' } }).catch(() => null)
      }
    }

    return reply.status(200).send({ received: true })
  })

  // ── Asaas Webhook ──────────────────────────────────────────────────────────
  app.post('/webhooks/asaas', async (request, reply) => {
    const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN
    if (webhookToken) {
      const requestToken = request.headers['asaas-access-token'] as string | undefined
      if (requestToken !== webhookToken) return reply.status(401).send({ message: 'Token inválido.' })
    }

    const body = request.body as { event?: string; payment?: { externalReference?: string; status?: string } }
    const event = body.event ?? ''
    const externalRef = body.payment?.externalReference ?? ''

    if (!externalRef) return reply.status(200).send({ received: true })

    const statusMap: Record<string, string> = {
      PAYMENT_CONFIRMED: 'active',
      PAYMENT_RECEIVED: 'active',
      PAYMENT_OVERDUE: 'past_due',
      PAYMENT_DELETED: 'suspended',
      PAYMENT_REFUNDED: 'suspended',
      SUBSCRIPTION_DELETED: 'suspended',
    }

    const newStatus = statusMap[event]
    if (newStatus) {
      const [accountId] = externalRef.split('|')
      if (accountId) {
        await prisma.account.update({ where: { id: accountId }, data: { status: newStatus } }).catch(() => null)
      }
    }

    return reply.status(200).send({ received: true })
  })
}
