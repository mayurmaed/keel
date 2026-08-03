# Security Policy

## Supported versions

Bareboat is pre-1.0 (`0.x`). Only the latest commit on the active integration
branch is supported — there are no maintained release branches yet.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities.

Instead, report privately via GitHub's
[private vulnerability reporting](https://github.com/mayurmaed/bareboat/security/advisories/new)
(Security tab → "Report a vulnerability"), or email the maintainer directly.
Include:

- A description of the issue and its impact
- Steps to reproduce (or a PoC, if applicable)
- Affected file(s)/command(s)

Given Bareboat provisions real AWS resources on the user's behalf (IAM roles,
CodeBuild, ECS, DynamoDB, SSM), issues involving credential handling, IAM
scoping, or webhook signature verification are treated as high priority.

We'll acknowledge reports within a few days and keep you updated as a fix is
developed. Please allow time for a fix before any public disclosure.
