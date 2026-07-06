# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: signup.gallery.spec.js >> 54 onboard – step2 back retains connected account [en-light-mobile]
- Location: tests\specs\signup.gallery.spec.js:537:3

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e6]:
  - generic [ref=e7]: munni.
  - generic [ref=e8]: Set up your profile
  - generic [ref=e9]: Almost there — just a few more details.
  - button "A" [ref=e11] [cursor=pointer]:
    - generic [ref=e12]: A
    - img [ref=e14]
  - generic [ref=e18]:
    - generic [ref=e19]:
      - generic [ref=e20]: First name
      - textbox "e.g. Jan" [ref=e21]: Alice
    - generic [ref=e22]:
      - generic [ref=e23]: Last name
      - textbox "e.g. de Vries" [active] [ref=e24]: Smith
  - generic [ref=e25]:
    - generic [ref=e26]: Email address
    - generic [ref=e27]:
      - img [ref=e28]
      - generic [ref=e31]: test-back-bank-enlightmobile@example.com
      - img [ref=e32]
  - generic [ref=e35]:
    - generic [ref=e36]:
      - generic [ref=e37]: Country
      - button [ref=e38] [cursor=pointer]:
        - img [ref=e39]
    - button "NL Netherlands" [ref=e41] [cursor=pointer]:
      - img "NL" [ref=e42]
      - generic [ref=e43]: Netherlands
      - img [ref=e44]
    - generic [ref=e46]:
      - generic [ref=e47]: Currency
      - button "€ Euro EUR" [ref=e48] [cursor=pointer]:
        - generic [ref=e49]: €
        - generic [ref=e50]: Euro EUR
        - img [ref=e51]
  - generic [ref=e53]:
    - generic [ref=e54]:
      - generic [ref=e55]: API endpoint
      - button [ref=e56] [cursor=pointer]:
        - img [ref=e57]
    - textbox "e.g. api.munni.app:443" [ref=e59]: apollousa.okkes.synology.me:443
  - button "Continue" [ref=e60] [cursor=pointer]
```