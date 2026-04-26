# Wrapper script to run Hardhat commands with proper environment
param(
    [string]$Command
)

# Set clean environment
$env:USERPROFILE = "C:\Users\Jimmy"
$env:APPDATA = "C:\Users\Jimmy\AppData\Roaming"
$env:LOCALAPPDATA = "C:\Users\Jimmy\AppData\Local"
$env:TEMP = "C:\Users\Jimmy\AppData\Local\Temp"
$env:TMP = "C:\Users\Jimmy\AppData\Local\Temp"

# Clear npm cache paths that might point to wrong user
Remove-Item Env:\npm_config_cache -ErrorAction SilentlyContinue
Remove-Item Env:\npm_config_prefix -ErrorAction SilentlyContinue

# Set project-local npm cache
$env:npm_config_cache = "$PSScriptRoot\.npm-cache"

# Run the command
Invoke-Expression "npx --yes hardhat $Command"
