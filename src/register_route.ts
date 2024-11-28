import { interpolate } from './interpolate.js'

const pathParser = <PARAMS>(path: string, params: PARAMS) => interpolate(path, params)

export const register = <
  IO extends {
    output: any
    input: any
  },
>(params: {
  path: string
  method: string
  form: boolean
}) => {
  return {
    path: (p?: IO['input'] extends { params: any } ? IO['input']['params'] : undefined) =>
      pathParser(params.path, p),
    method: params.method,
    form: params.form,
    io: {} as IO,
  } as const
}
