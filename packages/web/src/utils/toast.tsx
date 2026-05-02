import { notifications } from '@mantine/notifications'
import { IconCheck, IconX, IconInfoCircle } from '@tabler/icons-react'

export function showSuccessToast(message: string) {
  notifications.show({
    message,
    color: 'gray',
    icon: <IconCheck size={16} />,
    autoClose: 4000,
    withBorder: true,
    withCloseButton: true,
    className: 'animate-slide-down',
  })
}

export function showErrorToast(message: string) {
  notifications.show({
    message,
    color: 'gray',
    icon: <IconX size={16} />,
    autoClose: 5000,
    withBorder: true,
    withCloseButton: true,
    className: 'animate-slide-down',
  })
}

export function showInfoToast(message: string) {
  notifications.show({
    message,
    color: 'gray',
    icon: <IconInfoCircle size={16} />,
    autoClose: 4000,
    withBorder: true,
    withCloseButton: true,
    className: 'animate-slide-down',
  })
}