import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'

async function getCredencial(accountId: string, chave: string): Promise<string | null> {
  const cred = await prisma.credencial.findUnique({
    where: { accountId_chave: { accountId, chave } },
  })
  if (!cred?.ativa) return null
  return decrypt(cred.valorCriptografado)
}

async function scrapeWebsite(url: string, firecrawlKey: string | null): Promise<string> {
  if (firecrawlKey) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${firecrawlKey}` },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      })
      if (res.ok) {
        const data = await res.json() as { success?: boolean; data?: { markdown?: string } }
        return data.data?.markdown?.slice(0, 4000) ?? ''
      }
    } catch { /* fall through to simple fetch */ }
  }

  // Fallback: raw fetch + strip tags
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const html = await res.text()
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000)
    return text
  } catch { return '' }
}

export async function contatosRoutes(app: FastifyInstance) {
  app.get('/contatos', { preValidation: [requireAuth] }, async (request, reply) => {
    const query = z.object({
      listaId: z.string().uuid().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(request.query)

    const { accountId } = request.user as JwtPayload
    const skip = (query.page - 1) * query.limit

    const where = query.listaId
      ? { listaContatos: { some: { lista: { id: query.listaId, accountId } } } }
      : { listaContatos: { some: { lista: { accountId } } } }

    const [contatos, total] = await Promise.all([
      prisma.contato.findMany({ where, skip, take: query.limit, orderBy: { createdAt: 'desc' } }),
      prisma.contato.count({ where }),
    ])

    return reply.send({ contatos, total, page: query.page, limit: query.limit })
  })

  app.post('/contatos', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      nomeEmpresa: z.string().min(1),
      contatoNome: z.string().optional(),
      telefone: z.string().min(8),
      endereco: z.string().optional(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
      cnpj: z.string().optional(),
      listaId: z.string().uuid().optional(),
    }).parse(request.body)

    const { listaId, ...contatoData } = body
    const contato = await prisma.contato.create({ data: contatoData })

    if (listaId) {
      await prisma.listaContato.create({ data: { listaId, contatoId: contato.id } }).catch(() => null)
    }

    return reply.status(201).send({ contato })
  })

  app.get('/contatos/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const contato = await prisma.contato.findUnique({
      where: { id },
      include: { interacoes: { orderBy: { data: 'desc' }, take: 20 } },
    })
    if (!contato) return reply.status(404).send({ message: 'Contato não encontrado.' })
    return reply.send({ contato })
  })

  app.patch('/contatos/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      nomeEmpresa: z.string().optional(),
      contatoNome: z.string().optional(),
      telefone: z.string().optional(),
      endereco: z.string().optional(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
      cnpj: z.string().optional(),
    }).parse(request.body)

    const contato = await prisma.contato.update({ where: { id }, data: body })
    return reply.send({ contato })
  })

  app.get('/contatos/:id/foto-perfil', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const contato = await prisma.contato.findUnique({ where: { id }, select: { telefone: true } })
    if (!contato) return reply.status(404).send({ message: 'Contato não encontrado.' })

    // TODO: integrar com provider WhatsApp para buscar foto de perfil
    return reply.send({ fotoUrl: null })
  })

  app.post('/contatos/:id/enriquecer', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)

    const contato = await prisma.contato.findUnique({ where: { id } })
    if (!contato) return reply.status(404).send({ message: 'Contato não encontrado.' })
    if (!contato.website) return reply.status(400).send({ message: 'Contato sem website cadastrado.' })

    const [openaiKey, firecrawlKey] = await Promise.all([
      getCredencial(accountId, 'OPENAI_API_KEY'),
      getCredencial(accountId, 'FIRECRAWL_API_KEY'),
    ])
    if (!openaiKey) return reply.status(400).send({ message: 'Credencial OpenAI não configurada.' })

    const conteudo = await scrapeWebsite(contato.website, firecrawlKey)
    if (!conteudo) return reply.status(422).send({ message: 'Não foi possível extrair conteúdo do site.' })

    const prompt = `Você é especialista em copywriting B2B para prospecção via WhatsApp.
Com base no conteúdo do site da empresa abaixo, gere dois campos de personalização:

1. ganchoPersonalizacao: Uma frase de abertura personalizada (máx. 80 chars) que demonstre que você pesquisou sobre a empresa. Ex: "Vi que vocês atuam com [algo específico do site]..."
2. provaSocial: Um dado ou diferencial observado no site que pode ser usado como prova social na abordagem (máx. 120 chars).

Empresa: ${contato.nomeEmpresa}
Site: ${contato.website}

Conteúdo do site:
${conteudo}

Responda APENAS em JSON válido: {"ganchoPersonalizacao":"...","provaSocial":"..."}`

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) return reply.status(502).send({ message: 'Erro ao chamar OpenAI.' })
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const raw = data.choices?.[0]?.message?.content ?? '{}'

    let enriched: { ganchoPersonalizacao?: string; provaSocial?: string } = {}
    try { enriched = JSON.parse(raw) } catch { /* keep empty */ }

    const updated = await prisma.contato.update({
      where: { id },
      data: {
        ganchoPersonalizacao: enriched.ganchoPersonalizacao ?? contato.ganchoPersonalizacao,
        provaSocial: enriched.provaSocial ?? contato.provaSocial,
      },
    })

    return reply.send({ contato: updated })
  })
}
