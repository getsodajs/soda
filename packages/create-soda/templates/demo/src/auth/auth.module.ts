import { Module } from '@getsoda/core'
import { JwtModule } from '@getsoda/core/jwt'
import { AppConfig } from '../config.ts'
import { AuthController } from './auth.controller.ts'
import { TOKEN_COOKIE, TOKEN_LIFETIME } from './token.ts'

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config) => ({ secret: config.JWT_SECRET, expiresIn: TOKEN_LIFETIME, cookie: TOKEN_COOKIE }),
      global: true,
    }),
  ],
  controllers: [AuthController],
})
export class AuthModule {}
