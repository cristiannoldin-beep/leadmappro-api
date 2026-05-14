import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function whatsappRoutes(app: FastifyInstance) {
  app.get('/whatsapp/conexoes', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const conexoes = await prisma.whatsappConexao.findMany({
      where: { accountId },
      select: {
        id: true, provider: true, status: true, numeroTelefone: true,
        apelido: true, wabaId: true, phoneNumberId: true,
        instanceName: true, createdAt: true, updatedAt: true,
      },
    })
    return reply.send({ conexoes })
  })

  app.post('/whatsapp/conexoes', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      provider: z.enum(['meta_official', 'uazapi']),
      apelido: z.string().optional(),
      numeroTelefone: z.string().optional(),
      wabaId: z.string().optional(),
      phoneNumberId: z.string().optional(),
      accessToken: z.string().optional(),
      instanceName: z.string().optional(),
      instanceKey: z.string().optional(),
    }).parse(request.body)

    const conexao = await prisma.whatsappConexao.create({ data: { ...body, accountId } })
    const { accessToken: _, instanceKey: __, ...safeConexao } = conexao
    return reply.status(201).send({ conexao: safeConexao })
  })

  app.delete('/whatsapp/conexoes/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const exists = await prisma.whatsappConexao.findFirst({ where: { id, accountId } })
    if (!exists) return reply.status(404).send({ message: 'Conexão não encontrada.' })
    await prisma.whatsappConexao.delete({ where: { id } })
    return reply.status(204).send()
  })

  // Substitui: gerar-qr-code
  app.get('/whatsapp/:id/qrcode', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const conexao = await prisma.whatsappConexao.findFirst({ where: { id, accountId } })
    if (!conexao) return reply.status(404).send({ message: 'Conexão não encontrada.' })

    // TODO: chamar UazAPI para gerar QR code
    return reply.send({ qrcode: null, message: 'TODO: gerar QR code via UazAPI' })
  })

  // Substitui: validar-whatsapp-lote
  app.post('/validacao/whatsapp-lote', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      telefones: z.array(z.string()),
      conexaoId: z.string().uuid(),
    }).parse(request.body)

    // TODO: validar números via provider WhatsApp
    return reply.send({ resultados: [], message: 'TODO: validação em lote WhatsApp' })
  })
}
