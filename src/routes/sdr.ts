import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, JwtPayload } from '../lib/auth'
import { prisma } from '../lib/prisma'
import { decrypt } from '../lib/encryption'

async function sendViaWaha(accountId: string, telefone: string, mensagem: string): Promise<boolean> {
  const conexao = await prisma.whatsappConexao.findFirst({
    where: { accountId, status: 'connected' }, orderBy: { createdAt: 'asc' },
  })
  if (!conexao?.instanceKey) return false

  const cred = await prisma.credencial.findUnique({ where: { accountId_chave: { accountId, chave: 'UAZAPI_BASE_URL' } } })
  const baseUrl = cred?.ativa ? decrypt(cred.valorCriptografado) : 'https://api.uazapi.com'
  const phone = telefone.replace(/\D/g, '').startsWith('55') ? telefone.replace(/\D/g, '') : `55${telefone.replace(/\D/g, '')}`

  try {
    const res = await fetch(`${baseUrl}/v1/messages/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'instance-key': conexao.instanceKey },
      body: JSON.stringify({ phone, body: mensagem }),
    })
    return res.ok
  } catch { return false }
}

export async function sdrRoutes(app: FastifyInstance) {
  app.get('/sdr/configuracao', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const config = await prisma.sdrConfiguracao.findUnique({ where: { accountId } })
    return reply.send({ config })
  })

  app.put('/sdr/configuracao', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      ativo: z.boolean().optional(),
      mensagemFollowup1: z.string().optional(),
      mensagemFollowup2: z.string().optional(),
      delayFollowup1Horas: z.number().optional(),
      delayFollowup2Horas: z.number().optional(),
    }).parse(request.body)

    const config = await prisma.sdrConfiguracao.upsert({
      where: { accountId },
      update: { ...body, updatedAt: new Date() },
      create: { accountId, ...body },
    })
    return reply.send({ config })
  })

  // Cron de follow-up SDR — processa follow-ups para todas as contas com SDR ativo
  app.post('/sdr/processar-followup', async (request, reply) => {
    const cronSecret = request.headers['x-cron-secret']
    if (cronSecret !== process.env.CRON_SECRET) {
      return reply.status(401).send({ message: 'Não autorizado.' })
    }

    const configs = await prisma.sdrConfiguracao.findMany({ where: { ativo: true } })
    let processados = 0

    for (const config of configs) {
      const accountId = config.accountId
      const delay1Ms = (config.delayFollowup1Horas ?? 24) * 3600_000
      const delay2Ms = (config.delayFollowup2Horas ?? 48) * 3600_000
      const agora = Date.now()

      // Follow-up 1: etapa 'primeira_msg', sem resposta recebida, dentro do delay
      if (config.mensagemFollowup1) {
        const corte1 = new Date(agora - delay1Ms)
        const candidatos = await prisma.campanhaContato.findMany({
          where: {
            etapa: 'primeira_msg',
            resultado: null,
            dataUltimaAcao: { lt: corte1 },
            campanha: { accountId },
          },
          include: {
            contato: { select: { telefone: true, nomeEmpresa: true } },
            campanha: { select: { accountId: true } },
          },
          take: 50,
        })

        for (const cc of candidatos) {
          // Verificar se não houve resposta recebida do contato
          const respostasRecentes = await prisma.interacao.count({
            where: {
              contatoId: cc.contatoId,
              accountId,
              direcao: 'recebido',
              data: { gte: cc.dataUltimaAcao ?? new Date(0) },
            },
          })
          if (respostasRecentes > 0) continue

          const telefone = cc.contato.telefone ?? ''
          if (!telefone) continue

          const mensagem = config.mensagemFollowup1
            .replace(/\{nome_empresa\}/gi, cc.contato.nomeEmpresa)

          await sendViaWaha(accountId, telefone, mensagem)
          await prisma.campanhaContato.update({
            where: { id: cc.id },
            data: { resultado: 'followup1_enviado', dataUltimaAcao: new Date() },
          })
          processados++
          await new Promise(r => setTimeout(r, 500))
        }
      }

      // Follow-up 2: resultado 'followup1_enviado', sem resposta, dentro do delay2
      if (config.mensagemFollowup2) {
        const corte2 = new Date(agora - delay2Ms)
        const candidatos2 = await prisma.campanhaContato.findMany({
          where: {
            resultado: 'followup1_enviado',
            dataUltimaAcao: { lt: corte2 },
            campanha: { accountId },
          },
          include: {
            contato: { select: { telefone: true, nomeEmpresa: true } },
          },
          take: 50,
        })

        for (const cc of candidatos2) {
          const respostasRecentes = await prisma.interacao.count({
            where: { contatoId: cc.contatoId, accountId, direcao: 'recebido', data: { gte: cc.dataUltimaAcao ?? new Date(0) } },
          })
          if (respostasRecentes > 0) { await prisma.campanhaContato.update({ where: { id: cc.id }, data: { resultado: 'respondeu', etapa: 'finalizado' } }); continue }

          const telefone = cc.contato.telefone ?? ''
          if (!telefone) continue

          const mensagem = config.mensagemFollowup2
            .replace(/\{nome_empresa\}/gi, cc.contato.nomeEmpresa)

          await sendViaWaha(accountId, telefone, mensagem)
          await prisma.campanhaContato.update({
            where: { id: cc.id },
            data: { resultado: 'sem_resposta', etapa: 'finalizado', dataUltimaAcao: new Date() },
          })
          processados++
          await new Promise(r => setTimeout(r, 500))
        }
      }
    }

    return reply.send({ processados })
  })
}
