import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'

export default function UserMenu({
  showName = false,
  square = false,
}: {
  showName?: boolean
  square?: boolean
} = {}) {
  const { authenticatedApi, logout, currentUser, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()

  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)
  const name = currentUser?.name?.trim() || 'Account'

  const initials = currentUser?.name
    ? currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U'

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            className={
              showName
                ? 'flex min-w-0 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left transition-colors hover:bg-kumo-tint'
                : [
                    'flex cursor-pointer items-center justify-center overflow-hidden bg-kumo-tint transition-colors hover:bg-kumo-fill',
                    square ? 'h-5 w-5 rounded-md' : 'h-7 w-7 rounded-full',
                  ].join(' ')
            }
            title="Open profile menu"
            aria-label="Open profile menu"
          >
            <span
              className={[
                'flex shrink-0 items-center justify-center overflow-hidden bg-kumo-tint',
                square || showName ? 'h-5 w-5 rounded-md' : 'h-7 w-7 rounded-full',
              ].join(' ')}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-[10px] font-medium text-kumo-strong">{initials}</span>
              )}
            </span>
            {showName && (
              <span className="min-w-0 truncate text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default">
                {name}
              </span>
            )}
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className={MENU_ITEM}
        >
          Profile
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/gatekeepers' })}
          className={MENU_ITEM}
        >
          Connectors
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className={MENU_ITEM}
        >
          Providers
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            Admin
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
