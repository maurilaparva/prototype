import { useEffect, useState } from 'react'

export const useLocalStorage = <T>(
  key: string,
  initialValue: T
): [T, (value: T) => void] => {
  const [storedValue, setStoredValue] = useState<T>(initialValue)

  useEffect(() => {
    try {
      const item = window.localStorage.getItem(key)
      if (item !== null) {
        setStoredValue(JSON.parse(item))
      }
    } catch (error) {
      console.warn(`[localStorage] Failed to parse stored value for key "${key}":`, error)
      window.localStorage.removeItem(key) // remove the corrupted value
      setStoredValue(initialValue)
    }
  }, [key])

  const setValue = (value: T) => {
    setStoredValue(value)
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      console.error(`[localStorage] Failed to store value for key "${key}":`, error)
    }
  }

  return [storedValue, setValue]
}
