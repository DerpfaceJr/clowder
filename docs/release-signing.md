# Release signing: owner steps (plan rows 7.8 and 7.9)

Each fact links its page, with the access date in the link text. NOT VERIFIED means I did not read it on a primary page.

**Cost and what users see.** Artifact Signing Basic is $9.99/month (PUBLISHED, `prices.azure.com/api/retail/prices`, read 2026-11-07, per durability §7; re-check before paying). It needs a paid Azure subscription: free, trial and sponsored ones are refused ([faq 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)). The fee is not prorated (same page). Every installer and UAC prompt shows your validated legal name as publisher; a custom name is not possible (same page). SignPath would show "SignPath Foundation" (durability §7). SmartScreen reputation still builds over time (same page).

## 1. Azure

1. Create or pick a pay-as-you-go subscription. Its billing account must have Account Type "Individual", and the legal name and sold-to address on it must match your government ID ([quickstart 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)). Fix them first: they appear on the certificate.
2. Register the provider: `az provider register --namespace "Microsoft.CodeSigning"` ([quickstart 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)). Check with `az provider show --namespace "Microsoft.CodeSigning"`.
3. Create an Artifact Signing account (portal: "Artifact Signing Accounts", Create) with SKU Basic. The name is 3 to 24 letters, digits or hyphens, globally unique. Pick a listed region, e.g. East US with endpoint `https://eus.codesigning.azure.net` ([quickstart 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)). The endpoint must match the account's region or you get 403 ([integrations 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)). Creating it needs at least Contributor ([roles 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)).
4. On the account's Access control (IAM), add yourself as **Artifact Signing Identity Verifier**. It needs at least Reader on the subscription ([roles 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)). Without it "New identity" is greyed out ([quickstart 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)).
5. Identity validation (portal only): Identity validations, Individual, New identity, Public. Pick the billing account; the name and address fill in read-only. Your email and street are not on the certificate; city, province and country are ([quickstart 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)). Individuals must be in the USA or Canada (same page).
   - How it is checked: when the status shows Action Required, open the link and sign in with the same email as the request. A third party, AU10TIX, checks a government ID (passport, driving licence or ID card) with your phone camera. You then add a Verified ID to Microsoft Authenticator and share it, with a face check (same page, [faq 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)).
   - Wait: 1 to 20 business days is stated for public validation in general (same page). A figure for individuals alone: NOT VERIFIED.
   - Done when the status is Completed.
6. Certificate profile: Certificate profiles, Create, **Public Trust**. Under "Verified CN and O" pick the completed validation ([quickstart 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)). Name: 5 to 100 letters, digits or hyphens. Note the profile name.

## 2. The pipeline's identity

1. Entra admin center, App registrations, New. Copy the Application (client) ID and Directory (tenant) ID.
2. On it: Certificates & secrets, Federated credentials, Add, scenario "GitHub actions deploying Azure resources". Organization `DerpfaceJr`, repository `clowder`, entity type Environment, name `release` ([Entra 2026-11-07](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust)). Resulting values:
   - issuer `https://token.actions.githubusercontent.com`
   - subject `repo:DerpfaceJr/clowder:environment:release`
   - audience `api://AzureADTokenExchange`
3. **Check the subject after the repo exists.** Repos created after 2026-07-15 default to an immutable subject containing owner and repo IDs ([GitHub OIDC 2026-11-07](https://docs.github.com/en/actions/reference/security/oidc)). That page shows only branch examples; an environment form is NOT VERIFIED. A wrong subject fails silently ([Entra 2026-11-07](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust)). Run `github/actions-oidc-debugger` once in a job on the `release` environment (the page suggests it) and make the credential's subject match what it prints.
4. Give the app's service principal the signer role on the profile ([roles 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)). Use the Enterprise application's object ID (that it differs from the app registration's: NOT VERIFIED):
   ```
   az role assignment create --assignee <SP_OBJECT_ID> --role "Artifact Signing Certificate Profile Signer" --scope "/subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<RG>/providers/Microsoft.CodeSigning/codeSigningAccounts/<ACCOUNT>/certificateProfiles/<PROFILE>"
   ```
   Give yourself the same role for step 4 below.
5. If the pipeline needs a client secret instead, store it as an environment secret named `AZURE_CLIENT_SECRET`.

## 3. GitHub (after `DerpfaceJr/clowder` exists)

1. Settings, Environments, New environment, name `release`. Add yourself under Required reviewers ([GitHub environments 2026-11-07](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)). Private repos need Pro or Team; free plans cover public repos only (same page).
2. Add these environment variables (not secrets; read with `vars.`, same page):

| Name | Comes from |
|---|---|
| `AZURE_TENANT_ID` | App registration, Directory (tenant) ID |
| `AZURE_CLIENT_ID` | App registration, Application (client) ID |
| `AZURE_SUBSCRIPTION_ID` | Subscription overview |
| `AZURE_SIGNING_ENDPOINT` | Region table, step 1.3 |
| `AZURE_SIGNING_ACCOUNT` | Account name, step 1.3 |
| `AZURE_CERT_PROFILE` | Profile name, step 1.6 |
| `AZURE_PUBLISHER_NAME` | The certificate CN, step 4 below |

## 4. Proof for 7.8 (local signtool + dlib)

Install the tools: `winget install -e --id Microsoft.Azure.ArtifactSigningClientTools`. It needs signtool 10.0.2261.755 or later and the .NET 8 runtime ([integrations 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)). Where winget puts signtool and the dlib: NOT VERIFIED; the paths below are placeholders. I did not verify the `Invoke-ArtifactSigning` parameters, so this uses signtool.

```
az login
```
Save as `metadata.json`:
```
{ "Endpoint": "<ENDPOINT>", "CodeSigningAccountName": "<ACCOUNT>", "CertificateProfileName": "<PROFILE>" }
```
```
& "<SDK_BIN>\x64\signtool.exe" sign /v /debug /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 /dlib "<DLIB_BIN>\x64\Azure.CodeSigning.Dlib.dll" /dmdf "<PATH>\metadata.json" <TEST_FILE>
& "<SDK_BIN>\x64\signtool.exe" verify /pa /v <TEST_FILE>
(Get-AuthenticodeSignature <TEST_FILE>).SignerCertificate.Subject
```
The sign command is from the integrations page; `verify /pa /v` is from the FAQ. `az login` works because the dlib tries the Azure CLI credential ([integrations 2026-11-07](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)). Certificates last three days, so keep the timestamp. Use any unsigned `.exe` copy as `<TEST_FILE>`. `verify` must end "Successfully verified". The `CN=` value in the subject, your legal name, is `AZURE_PUBLISHER_NAME`. Paste it exactly.
