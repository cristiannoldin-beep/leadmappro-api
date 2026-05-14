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
  if (!reply.sent) reply.status((error as { statusCode?: number }).statusCode ?? 500).send({ message: error.message })
})

fastify.get('/health', async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return reply.send({ status: 'ok', database: 'connected', timestamp: new Date() })
  } catch {
    return reply.status(503).send({ status: 'error', database: 'disconnected' })
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

const start = async () => {
  await fastify.listen({ port: Number(process.env.PORT) || 3333, host: process.env.HOST || '0.0.0.0' })
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
