import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'

export async function webhooksRoutes(app: FastifyInstance) {
  // Substitui: webhook-whatsapp (UazAPI)
  app.post('/webhooks/whatsapp', async (request, reply) => {
    const secret = request.headers['x-webhook-secret']
    if (secret !== process.env.WEBHOOK_SECRET) {
      return reply.status(401).send({ message: 'Não autorizado.' })
    }
    // TODO: migrar lógica de webhook-whatsapp
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
