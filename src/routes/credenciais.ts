import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { encrypt, decrypt } from '../lib/encryption'

export async function credenciaisRoutes(app: FastifyInstance) {
  // Substitui: carregar-credenciais
  app.get('/credenciais', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const creds = await prisma.credencial.findMany({
      where: { accountId },
      select: { id: true, chave: true, ativa: true, statusTeste: true, atualizadoEm: true },
    })
    return reply.send({ credenciais: creds })
  })

  // Substitui: salvar-credencial
  app.post('/credenciais', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      chave: z.string().min(1),
      valor: z.string().min(1),
    }).parse(request.body)

    const valorCriptografado = encrypt(body.valor)
    const credencial = await prisma.credencial.upsert({
      where: { accountId_chave: { accountId, chave: body.chave } },
      update: { valorCriptografado, ativa: true, atualizadoEm: new Date() },
      create: { accountId, chave: body.chave, valorCriptografado, ativa: true },
      select: { id: true, chave: true, ativa: true, statusTeste: true, atualizadoEm: true },
    })
    return reply.status(201).send({ credencial })
  })

  // Substitui: testar-integracao
  app.post('/credenciais/testar', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({ chave: z.string() }).parse(request.body)

    const credencial = await prisma.credencial.findUnique({
      where: { accountId_chave: { accountId, chave: body.chave } },
    })
    if (!credencial) return reply.status(404).send({ message: 'Credencial não encontrada.' })

    const valor = decrypt(credencial.valorCriptografado)
    // TODO: testar integração conforme a chave
    await prisma.credencial.update({
      where: { id: credencial.id },
      data: { statusTeste: 'testado', atualizadoEm: new Date() },
    })
    return reply.send({ success: true })
  })
}
