import { FastifyRequest, FastifyReply } from 'fastify'

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
