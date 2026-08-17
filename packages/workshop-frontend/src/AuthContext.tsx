import { createContext, useContext, type ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { useAmIAdmin, useWhoami } from './query/hooks'
import { useWorkshopSession, workshopSession } from './session'

interface AuthContextType {
  authenticatedApi: RpcStub<AuthenticatedApi>
  logout: () => void
  currentUser: AiChatAuthorInfo | null
  isAdmin: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useWorkshopSession()
  const authenticatedApi = session.authenticatedApi
  if (!authenticatedApi) throw new Error('AuthProvider requires an authenticated session')
  const { data: currentUser = null } = useWhoami()
  const { data: isAdmin = false } = useAmIAdmin()

  const logout = () => {
    void workshopSession.logout().then(() => {
      window.location.assign('/login')
    })
  }

  return (
    <AuthContext.Provider value={{ authenticatedApi, logout, currentUser, isAdmin }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthenticatedApi() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuthenticatedApi must be used within an AuthProvider')
  }
  return context
}

export function useOptionalAuthenticatedApi(): AuthContextType | null {
  return useContext(AuthContext)
}
