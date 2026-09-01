# Move rpcd handler, init script, UCI config into root/

LuCI module guidelines specify root/ is copied verbatim to the target; files in root/ with git mode 100755 have executable bits preserved by luci.mk's $(CP). The files/ directory is eliminated; no custom install section needed in the Makefile.
