import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

function extractFromHtml(html: string) {
  // Email — prioriza href="mailto:..."
  let email: string | null = null
  const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
  if (mailtoMatch) {
    email = mailtoMatch[1].toLowerCase()
  } else {
    const emailMatch = html.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/)
    if (emailMatch) email = emailMatch[1].toLowerCase()
  }
  // Remove falsos positivos (arquivos de imagem/script)
  if (email && /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff|ttf)$/i.test(email)) email = null

  // Instagram — perfil apenas (exclui /p/, /reel/, /stories/)
  const igMatch = html.match(/instagram\.com\/(?!p\/|reel\/|stories\/|explore\/)([a-zA-Z0-9._]{3,30})\/?["'\s>]/i)
  const instagram = igMatch ? `https://instagram.com/${igMatch[1]}` : null

  // LinkedIn — página de empresa apenas (exclui /in/ perfis pessoais)
  const liMatch = html.match(/linkedin\.com\/company\/([a-zA-Z0-9._-]{2,60})\/?["'\s>]/i)
  const linkedin = liMatch ? `https://linkedin.com/company/${liMatch[1]}` : null

  // CNPJ
  const cnpjRaw = html.match(/\b(\d{2}[\.\-]?\d{3}[\.\-]?\d{3}[\/\.]?\d{4}[\.\-]?\d{2})\b/)
  const cnpj = cnpjRaw ? cnpjRaw[1].replace(/[^\d]/g, '') : null

  return { email, instagram, linkedin, cnpj }
}

export async function enriquecimentoRoutes(app: FastifyInstance) {
  // POST /listas/:id/enriquecer — enriquece contatos da lista com dados do site
  app.post('/listas/:id/enriquecer', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      limit: z.number().int().min(1).max(20).default(10),
      force: z.boolean().default(false),
    }).parse(request.body ?? {})

    const lista = await prisma.lista.findFirst({ where: { id, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const registros = await prisma.listaContato.findMany({
      where: {
        listaId: id,
        contato: {
          website: { not: null },
          ...(body.force ? {} : { enriquecidoEm: null }),
        },
      },
      include: { contato: true },
      take: body.limit,
      orderBy: { createdAt: 'asc' },
    })

    let enriquecidos = 0
    let semSite = 0
    let erros = 0

    for (const reg of registros) {
      const contato = reg.contato
      if (!contato.website) { semSite++; continue }

      try {
        const url = contato.website.startsWith('http') ? contato.website : `https://${contato.website}`
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadMapBot/1.0)' },
          signal: AbortSignal.timeout(10000),
        })

        if (!res.ok) { erros++; continue }

        const html = await res.text()
        const { email, instagram, linkedin, cnpj } = extractFromHtml(html)

        await prisma.contato.update({
          where: { id: contato.id },
          data: {
            ...(email && !contato.email ? { email } : {}),
            ...(instagram && !contato.instagram ? { instagram } : {}),
            ...(linkedin && !contato.linkedin ? { linkedin } : {}),
            ...(cnpj && !contato.cnpj ? { cnpj } : {}),
            enriquecidoEm: new Date(),
          },
        })
        enriquecidos++
      } catch {
        erros++
      }

      // Delay para não sobrecarregar os sites
      await new Promise(r => setTimeout(r, 800))
    }

    const restantes = await prisma.listaContato.count({
      where: {
        listaId: id,
        contato: { website: { not: null }, enriquecidoEm: null },
      },
    })

    return reply.send({ enriquecidos, erros, semSite, hasMore: restantes > 0, restantes })
  })
}
