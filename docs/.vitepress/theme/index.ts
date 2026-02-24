import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import './style.css'
import HomeLayout from './components/HomeLayout.vue'

export default {
  extends: DefaultTheme,
  Layout: HomeLayout,
} satisfies Theme
