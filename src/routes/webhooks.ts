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

    // Evento de atualização de status de conexão
    if (payload.event === 'connection.update') {
      const instanceName = payload.instance ?? ''
      const state = payload.data?.state ?? ''

      const status = state === 'open' ? 'connected'
        : state === 'close' ? 'disconnected'
        : state === 'connecting' ? 'connecting'
        : state

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

    // Evento de mensagem recebida
    if (payload.event === 'messages.upsert') {
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

  // Substitui: evolution-webhook
  app.post('/webhooks/evolution', async (request, reply) => {
    // TODO: migrar lógica de evolution-webhook
    return reply.status(200).send({ received: true })
  })

  // Substitui: meta-webhook
  app.get('/webhooks/meta', async (request, reply) => {
    const query = request.query as Record<string, string>
    const mode = query['hub.mode']
    const token = query['hub.verify_token']
    const challenge = query['hub.challenge']

    if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      return reply.status(200).send(challenge)
    }
    return reply.status(403).send({ message: 'Verificação falhou.' })
  })

  app.post('/webhooks/meta', async (request, reply) => {
    // TODO: migrar lógica de meta-webhook
    return reply.status(200).send({ received: true })
  })

  // Substitui: stripe-webhook
  app.post('/webhooks/stripe', async (request, reply) => {
    const sig = request.headers['stripe-signature'] as string
    if (!sig) return reply.status(400).send({ message: 'Assinatura ausente.' })
    // TODO: migrar lógica de stripe-webhook com Stripe SDK
    return reply.status(200).send({ received: true })
  })

  // Substitui: asaas-webhook
  app.post('/webhooks/asaas', async (request, reply) => {
    // TODO: migrar lógica de asaas-webhook
    return reply.status(200).send({ received: true })
  })
}
