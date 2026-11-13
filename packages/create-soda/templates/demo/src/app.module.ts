import { ConfigModule, Module } from '@getsoda/core'
import { AuthModule } from './auth/auth.module.ts'
import { AppConfig } from './config.ts'
import { UsersModule } from './users/users.module.ts'

@Module({ imports: [ConfigModule.forRoot({ load: [AppConfig], global: true }), AuthModule, UsersModule] })
export class AppModule {}
