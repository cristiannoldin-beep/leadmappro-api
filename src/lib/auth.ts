import { FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from './prisma'

export type JwtPayload = {
  sub: string
  email: string
  role: string
  accountId: string
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.status(401).send({ message: 'Não autorizado.' })
  }
}

export async function requireActiveAccount(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
    const { accountId } = request.user as JwtPayload
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { status: true, trialEndsAt: true } })
    if (!account) return reply.status(403).send({ message: 'Conta não encontrada.' })
    if (account.status === 'suspended') return reply.status(403).send({ message: 'Conta suspensa.' })
    if (account.status === 'trialing' && account.trialEndsAt && account.trialEndsAt < new Date()) {
      // Atualiza status no banco (fire-and-forget — não bloqueia a resposta)
      prisma.account.update({ where: { id: accountId }, data: { status: 'suspended' } }).catch(() => null)
      return reply.status(402).send({ message: 'Período de trial encerrado. Assine um plano para continuar.' })
    }
  } catch {
    return reply.status(401).send({ message: 'Não autorizado.' })
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
    const payload = request.user as JwtPayload
    if (payload.role !== 'admin') {
      return reply.status(403).send({ message: 'Acesso restrito a administradores.' })
    }
  } catch {
    return reply.status(401).send({ message: 'Não autorizado.' })
  }
}
