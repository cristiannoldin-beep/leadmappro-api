import 'dotenv/config'
import Fastify from 'fastify'
import { prisma } from './lib/prisma'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import { authRoutes } from './routes/auth'
import { contatosRoutes } from './routes/contatos'
import { listasRoutes } from './routes/listas'
import { campanhasRoutes } from './routes/campanhas'
import { prospeccaoRoutes } from './routes/prospeccao'
import { webhooksRoutes } from './routes/webhooks'
import { whatsappRoutes } from './routes/whatsapp'
import { chatsRoutes } from './routes/chats'
import { iaRoutes } from './routes/ia'
import { sdrRoutes } from './routes/sdr'
import { credenciaisRoutes } from './routes/credenciais'
import { billingRoutes } from './routes/billing'
import { metaRoutes } from './routes/meta'
import { adminRoutes } from './routes/admin'
import { dashboardRoutes } from './routes/dashboard'
import { crmRoutes } from './routes/crm'
import { enriquecimentoRoutes } from './routes/enriquecimento'

const fastify = Fastify({
  logger: true,
  bodyLimit: 20 * 1024 * 1024,
})

fastify.register(helmet)
fastify.register(cookie, { secret: process.env.JWT_SECRET })
fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' })
fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
})

if (!process.env.JWT_SECRET) throw new Error('FATAL: JWT_SECRET must be defined')

fastify.register(jwt, { secret: process.env.JWT_SECRET })

fastify.setErrorHandler(async (error, _request, reply) => {
  fastify.log.error(error)
  const err = error as Error & { statusCode?: number }
  if (!reply.sent) reply.status(err.statusCode ?? 500).send({ message: err.message })
})

fastify.get('/health', async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return reply.send({ status: 'ok', database: 'connected', uptime: process.uptime() })
  } catch {
    return reply.send({ status: 'ok', database: 'disconnected', uptime: process.uptime() })
  }
})

fastify.register(authRoutes)
fastify.register(contatosRoutes)
fastify.register(listasRoutes)
fastify.register(campanhasRoutes)
fastify.register(prospeccaoRoutes)
fastify.register(webhooksRoutes)
fastify.register(whatsappRoutes)
fastify.register(chatsRoutes)
fastify.register(iaRoutes)
fastify.register(sdrRoutes)
fastify.register(credenciaisRoutes)
fastify.register(billingRoutes)
fastify.register(metaRoutes)
fastify.register(adminRoutes)
fastify.register(dashboardRoutes)
fastify.register(crmRoutes)
fastify.register(enriquecimentoRoutes)

const DEFAULT_PLANS = [
  {
    name: 'Starter',
    price: 97,
    limits: { leads: 500, listas: 3, campanhas: 2, validacoesWhatsapp: 200, enriquecimentos: 50 },
  },
  {
    name: 'Profissional',
    price: 197,
    limits: { leads: 2000, listas: 10, campanhas: 10, validacoesWhatsapp: 1000, enriquecimentos: 300 },
  },
  {
    name: 'Agência',
    price: 397,
    limits: { leads: 10000, listas: 50, campanhas: 50, validacoesWhatsapp: 5000, enriquecimentos: 1000 },
  },
]

async function seedDefaultPlans() {
  try {
    const count = await prisma.plan.count()
    if (count > 0) return
    for (const plan of DEFAULT_PLANS) {
      await prisma.plan.create({ data: plan })
    }
    fastify.log.info('[seed] 3 planos padrão criados (Starter, Profissional, Agência).')
  } catch (err) {
    fastify.log.error({ err }, '[seed] Erro ao criar planos padrão.')
  }
}

async function expireTrials() {
  try {
    const { count } = await prisma.account.updateMany({
      where: { status: 'trialing', trialEndsAt: { lt: new Date() } },
      data: { status: 'suspended' },
    })
    if (count > 0) fastify.log.info(`[trial] ${count} conta(s) expirada(s) e suspensa(s).`)
  } catch (err) {
    fastify.log.error({ err }, '[trial] Erro ao expirar trials.')
  }
}

const start = async () => {
  await fastify.listen({ port: Number(process.env.PORT) || 3333, host: process.env.HOST || '0.0.0.0' })
  seedDefaultPlans()
  expireTrials()
  setInterval(expireTrials, 60 * 60 * 1000)
}

const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
signals.forEach((signal) => {
  process.on(signal, async () => {
    await fastify.close()
    await prisma.$disconnect()
    process.exit(0)
  })
})

start()
