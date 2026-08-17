import { createFileRoute } from '@tanstack/react-router'
import SettingsPage from '../../SettingsPage'

export const Route = createFileRoute('/_authenticated/profile')({
  component: SettingsPage,
})
