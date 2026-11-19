# Client/route conformance check

`check-routes.py` compares every path the API client can request against the
routes the API actually serves, read from its OpenAPI document.

```bash
pnpm dev:api                                        # in one terminal
python3 packages/api-client/test/check-routes.py    # in another
```

A renamed or moved route is otherwise invisible until it 404s inside one
screen, usually the one nobody opened during testing. This takes a second.

It also prints the routes the web consoles do not call, which is how the
mobile app's remaining surface stays visible.

One note on the extractor: the regex has to skip a *nested* generic, because
calls look like `client.get<Paged<VerificationQueueItem>>('/path')`. An earlier
version used `<[^>]*>`, which stopped at the first `>` and silently skipped
three calls — reporting success without having checked them. The script now
asserts that the number of matches equals the number of `client.` calls in the
file and exits with status 2 if they disagree, so the check cannot pass by
failing to look.
