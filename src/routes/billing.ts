import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function billingRoutes(app: FastifyInstance) {
  // Substitui: stripe-create-checkout
  app.post('/billing/checkout', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      planId: z.string(),
      successUrl: z.string().url(),
      cancelUrl: z.string().url(),
    }).parse(request.body)

    // TODO: criar sessão de checkout no Stripe
    return reply.send({ checkoutUrl: null, message: 'TODO: Stripe checkout' })
  })

  // Substitui: asaas-create-subscription
  app.post('/billing/asaas-subscription', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({ planId: z.string() }).parse(request.body)

    // TODO: criar assinatura no Asaas
    return reply.send({ subscriptionId: null, message: 'TODO: Asaas subscription' })
  })

  app.get('/billing/planos', async (_request, reply) => {
    // TODO: retornar planos do banco de dados
    return reply.send({ planos: [] })
  })
}
