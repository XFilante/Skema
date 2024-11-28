import { configApp } from '@adonisjs/eslint-config'

export default configApp({
  languageOptions: {
    parserOptions: {
      warnOnUnsupportedTypeScriptVersion: false,
    },
  },
})
