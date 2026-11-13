# HTTP benchmark

The same three routes in Bun alone, Hono, Soda and Nest (Express and Fastify adapters), each served by its own process and loaded by [oha](https://github.com/hatoo/oha). The scenarios are those of Hono's and SaltyAom's benchmarks:

- `GET /`: a text response;
- `GET /id/:id?name=`: a path parameter, a query parameter and a response header;
- `POST /json`: a JSON body echoed back.

```bash
brew install oha
cd bench/http && bun install
bun run bench                      # --duration=5 --rounds=3 --connections=100 --only=soda,hono
```

Every server is first checked to give the same responses, then warmed up. Each round measures every framework in turn and each result is the median of the rounds, so that a machine slowing down as it heats weighs on all of them alike. Only `200` responses count. The load generator runs on the same machine, so the numbers compare the frameworks with each other.

Soda is linked from `packages/core`: build it first (`bun run build` at the root). The latest results are in [RESULTS.md](./RESULTS.md).
