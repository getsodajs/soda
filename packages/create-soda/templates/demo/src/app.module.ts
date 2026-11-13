import { Module } from '@getsoda/core'
import { UsersModule } from './users/users.module.ts'

@Module({ imports: [UsersModule] })
export class AppModule {}
