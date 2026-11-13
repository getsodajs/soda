// Bun alone: native routes, the ceiling every framework adds to.
Bun.serve({
  port: Number(process.env.PORT),
  routes: {
    '/': { GET: () => new Response('Hi') },
    '/id/:id': {
      GET: (req) =>
        new Response(`${req.params.id} ${new URL(req.url).searchParams.get('name')}`, { headers: { 'x-powered-by': 'benchmark' } }),
    },
    '/json': { POST: async (req) => Response.json(await req.json()) },
  },
})
