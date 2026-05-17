import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', async (request, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      nomeCompleto: z.string().min(2),
      celular: z.string().optional().transform(v => v?.trim() || undefined),
    }).parse(request.body)

    const existing = await prisma.profile.findUnique({ where: { email: body.email } })
    if (existing) return reply.status(409).send({ message: 'Este email já está cadastrado.' })

    const hash = await bcrypt.hash(body.password, 12)
    const totalUsers = await prisma.profile.count()

    const profile = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: { name: body.nomeCompleto, slug: `${body.email.split('@')[0]}-${Date.now()}` },
      })
      const p = await tx.profile.create({
        data: {
          email: body.email,
          password: hash,
          nomeCompleto: body.nomeCompleto,
          celular: body.celular,
          role: totalUsers === 0 ? 'admin' : 'user',
        },
      })
      await tx.accountMember.create({ data: { accountId: account.id, userId: p.id, role: 'owner' } })
      return { ...p, accountId: account.id }
    })

    const token = app.jwt.sign(
      { sub: profile.id, email: profile.email, role: profile.role, accountId: profile.accountId },
      { expiresIn: '7d' }
    )

    return reply.status(201).send({
      token,
      user: { id: profile.id, email: profile.email, nomeCompleto: profile.nomeCompleto, role: profile.role },
    })
  })

  app.post('/auth/login', async (request, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }).parse(request.body)

    const profile = await prisma.profile.findUnique({
      where: { email: body.email },
      include: { accountMembers: { take: 1, orderBy: { createdAt: 'asc' } } },
    })

    if (!profile) return reply.status(401).send({ message: 'Email ou senha incorretos.' })

    const valid = await bcrypt.compare(body.password, profile.password)
    if (!valid) return reply.status(401).send({ message: 'Email ou senha incorretos.' })

    const accountId = profile.accountMembers[0]?.accountId ?? ''

    const token = app.jwt.sign(
      { sub: profile.id, email: profile.email, role: profile.role, accountId },
      { expiresIn: '7d' }
    )

    return reply.status(200).send({
      token,
      user: { id: profile.id, email: profile.email, nomeCompleto: profile.nomeCompleto, role: profile.role },
    })
  })

  app.get('/auth/me', { preValidation: [requireAuth] }, async (request, reply) => {
    const payload = request.user as JwtPayload
    const profile = await prisma.profile.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, nomeCompleto: true, celular: true, role: true, createdAt: true },
    })
    if (!profile) return reply.status(404).send({ message: 'Usuário não encontrado.' })
    return reply.send({ user: profile, accountId: payload.accountId })
  })

  app.post('/auth/logout', async (_request, reply) => {
    return reply.status(200).send({ success: true })
  })
}
