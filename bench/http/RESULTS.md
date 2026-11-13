# HTTP benchmark

Apple M1, 8 cores, 8 GB; Bun 1.4.3; hono 4.13.18, @nestjs/core 12.5.0, @getsoda/core 0.3.0 from this repository.
oha, 100 connections, 5 s per scenario after 3 s of warm-up; median of 3 rounds; successful responses only.

| Framework | GET / (req/s) | GET /id/:id?name= (req/s) | POST /json (req/s) | Average | vs Bun (native routes) |
|---|---:|---:|---:|---:|---:|
| Bun (native routes) | 132,064 <sub>p99 1.7 ms</sub> | 109,145 <sub>p99 1.9 ms</sub> | 89,249 <sub>p99 2.4 ms</sub> | 110,153 | 100% |
| Hono | 124,124 <sub>p99 1.7 ms</sub> | 103,020 <sub>p99 2.1 ms</sub> | 80,846 <sub>p99 2.4 ms</sub> | 102,663 | 93% |
| Soda | 126,058 <sub>p99 1.8 ms</sub> | 103,634 <sub>p99 2.1 ms</sub> | 81,630 <sub>p99 2.4 ms</sub> | 103,774 | 94% |
| Nest (Fastify) | 59,874 <sub>p99 3.2 ms</sub> | 52,124 <sub>p99 4.8 ms</sub> | 42,984 <sub>p99 4.6 ms</sub> | 51,661 | 47% |
| Nest (Express) | 50,409 <sub>p99 4.1 ms</sub> | 46,839 <sub>p99 4.0 ms</sub> | 34,726 <sub>p99 5.5 ms</sub> | 43,991 | 40% |
