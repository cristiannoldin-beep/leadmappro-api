import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'
import { decrypt } from '../lib/encryption'

async function getAsaasKey(accountId: string): Promise<string | null> {
  const cred = await prisma.credencial.findUnique({
    where: { accountId_chave: { accountId, chave: 'ASAAS_API_KEY' } },
  })
  if (!cred?.ativa) return null
  return decrypt(cred.valorCriptografado)
}

async function getStripeKey(accountId: string): Promise<string | null> {
  const cred = await prisma.credencial.findUnique({
    where: { accountId_chave: { accountId, chave: 'STRIPE_SECRET_KEY' } },
  })
  if (!cred?.ativa) return null
  return decrypt(cred.valorCriptografado)
}

export async function billingRoutes(app: FastifyInstance) {
  app.get('/billing/planos', async (_request, reply) => {
    const planos = await prisma.plan.findMany({ orderBy: { price: 'asc' } })
    return reply.send({
      planos: planos.map(p => ({ ...p, price: Number(p.price) })),
    })
  })

  app.get('/billing/plano', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { plan: true },
    })
    return reply.send({
      plano: account?.plan
        ? { ...account.plan, price: Number(account.plan.price) }
        : null,
      status: account?.status ?? 'active',
    })
  })

  app.post('/billing/checkout', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      planId: z.string(),
      successUrl: z.string().url(),
      cancelUrl: z.string().url(),
      provider: z.enum(['stripe', 'asaas']).default('stripe'),
    }).parse(request.body)

    const plan = await prisma.plan.findUnique({ where: { id: body.planId } })
    if (!plan) return reply.status(404).send({ message: 'Plano não encontrado.' })

    if (body.provider === 'stripe') {
      const stripeKey = await getStripeKey(accountId)
      if (!stripeKey) return reply.status(400).send({ message: 'Credencial Stripe não configurada.' })

      const account = await prisma.account.findUnique({
        where: { id: accountId },
        include: { members: { include: { user: { select: { email: true } } }, where: { role: 'owner' }, take: 1 } },
      })
      const ownerEmail = account?.members[0]?.user?.email

      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          'mode': 'subscription',
          'success_url': body.successUrl,
          'cancel_url': body.cancelUrl,
          ...(ownerEmail ? { 'customer_email': ownerEmail } : {}),
          'line_items[0][price_data][currency]': 'brl',
          'line_items[0][price_data][product_data][name]': plan.name,
          'line_items[0][price_data][unit_amount]': String(Math.round(Number(plan.price) * 100)),
          'line_items[0][price_data][recurring][interval]': 'month',
          'line_items[0][quantity]': '1',
          'metadata[accountId]': accountId,
          'metadata[planId]': body.planId,
        }),
      })

      if (!res.ok) {
        const err = await res.json() as { error?: { message?: string } }
        return reply.status(502).send({ message: err.error?.message ?? 'Erro ao criar sessão Stripe.' })
      }
      const session = await res.json() as { url?: string; id?: string }
      return reply.send({ checkoutUrl: session.url, sessionId: session.id })
    }

    // Asaas
    if (body.provider === 'asaas') {
      const asaasKey = await getAsaasKey(accountId)
      if (!asaasKey) return reply.status(400).send({ message: 'Credencial Asaas não configurada.' })

      const account = await prisma.account.findUnique({
        where: { id: accountId },
        include: { members: { include: { user: { select: { email: true, nomeCompleto: true, celular: true } } }, where: { role: 'owner' }, take: 1 } },
      })
      const owner = account?.members[0]?.user

      const asaasBase = process.env.ASAAS_ENV === 'production'
        ? 'https://api.asaas.com/v3'
        : 'https://sandbox.asaas.com/api/v3'

      // Criar ou buscar customer no Asaas
      const customerRes = await fetch(`${asaasBase}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'access_token': asaasKey },
        body: JSON.stringify({
          name: owner?.nomeCompleto ?? account?.name ?? 'Cliente',
          email: owner?.email ?? '',
          mobilePhone: owner?.celular ?? '',
          externalReference: accountId,
        }),
      })

      if (!customerRes.ok) return reply.status(502).send({ message: 'Erro ao criar customer no Asaas.' })
      const customer = await customerRes.json() as { id?: string }
      if (!customer.id) return reply.status(502).send({ message: 'Erro ao criar customer no Asaas.' })

      // Criar assinatura
      const subRes = await fetch(`${asaasBase}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'access_token': asaasKey },
        body: JSON.stringify({
          customer: customer.id,
          billingType: 'CREDIT_CARD',
          value: Number(plan.price),
          nextDueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
          cycle: 'MONTHLY',
          description: `Assinatura ${plan.name} - LeadMap Pro`,
          externalReference: `${accountId}|${body.planId}`,
        }),
      })

      if (!subRes.ok) return reply.status(502).send({ message: 'Erro ao criar assinatura no Asaas.' })
      const subscription = await subRes.json() as { id?: string; paymentLink?: string }

      return reply.send({
        subscriptionId: subscription.id,
        checkoutUrl: subscription.paymentLink ?? null,
      })
    }

    return reply.status(400).send({ message: 'Provider inválido.' })
  })

  // Webhook Asaas — atualiza status da conta ao receber pagamento
  app.post('/billing/webhook/asaas', async (request, reply) => {
    const body = request.body as { event?: string; payment?: { externalReference?: string; status?: string } }
    const event = body.event ?? ''
    const payment = body.payment

    if (event === 'PAYMENT_RECEIVED' && payment?.externalReference) {
      const [accountId, planId] = payment.externalReference.split('|')
      if (accountId && planId) {
        await prisma.account.update({
          where: { id: accountId },
          data: { planId, status: 'active' },
        }).catch(() => null)
      }
    }

    return reply.send({ received: true })
  })

  // Webhook Stripe — atualiza status ao receber checkout.session.completed
  app.post('/billing/webhook/stripe', async (request, reply) => {
    const body = request.body as {
      type?: string
      data?: { object?: { metadata?: { accountId?: string; planId?: string }; payment_status?: string } }
    }

    if (body.type === 'checkout.session.completed') {
      const session = body.data?.object
      const accountId = session?.metadata?.accountId
      const planId = session?.metadata?.planId
      if (accountId && planId && session?.payment_status === 'paid') {
        await prisma.account.update({
          where: { id: accountId },
          data: { planId, status: 'active' },
        }).catch(() => null)
      }
    }

    return reply.send({ received: true })
  })
}
