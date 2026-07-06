# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: signup.gallery.spec.js >> 58 bank-search – no skip link at bottom [en-light-mobile]
- Location: tests\specs\signup.gallery.spec.js:608:3

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e5]:
  - generic [ref=e6]:
    - img [ref=e7]
    - generic [ref=e8]:
      - generic [ref=e9]:
        - img "munni" [ref=e10]
        - generic [ref=e11]: munni.
      - button "English" [ref=e13] [cursor=pointer]:
        - generic [ref=e14]: English
        - img [ref=e15]
    - generic [ref=e17]:
      - generic [ref=e18]: Welcome
      - generic [ref=e19]: Sign in to continue your financial journey.
  - generic [ref=e20]:
    - generic [ref=e21]:
      - button "Continue with Apple" [ref=e22] [cursor=pointer]:
        - img [ref=e23]
        - text: Continue with Apple
      - button "Continue with Google" [ref=e25] [cursor=pointer]:
        - img [ref=e26]
        - text: Continue with Google
    - generic [ref=e33]: or
    - generic [ref=e35]:
      - generic:
        - img
      - textbox "Enter your email" [ref=e36]
    - button "Continue" [disabled]:
      - text: Continue
      - img
    - button "Don't have an account? Sign up" [ref=e37] [cursor=pointer]
    - generic [ref=e39]:
      - button "Offline mode" [ref=e40] [cursor=pointer]:
        - img [ref=e41]
        - generic [ref=e44]: Offline mode
        - img [ref=e45]
      - button "Continue as demo user" [ref=e47] [cursor=pointer]:
        - img [ref=e48]
        - generic [ref=e51]: Continue as demo user
        - img [ref=e52]
    - generic [ref=e54]:
      - text: By continuing you agree to our
      - button "Terms of Service" [ref=e55] [cursor=pointer]
      - text: and
      - button "Privacy Policy" [ref=e56] [cursor=pointer]
```