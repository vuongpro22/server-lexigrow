import jwt from 'jsonwebtoken'

export const setAuthCookie = (user, res) => {
  const token = jwt.sign({ id: user._id, passwordVersion: user.passwordVersion || 0 }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '24h',
  })
  res.cookie('token', token, {
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    path: '/',
  })
}
