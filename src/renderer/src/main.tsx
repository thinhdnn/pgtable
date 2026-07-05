import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { ThemeModeProvider } from './theme'
import { ActiveConnectionProvider } from './store/active-connection'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000
    }
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeModeProvider>
        <ActiveConnectionProvider>
          <App />
        </ActiveConnectionProvider>
      </ThemeModeProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
