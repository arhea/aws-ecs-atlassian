
install: clean
	npm install

deploy:
	npx cdk deploy

destroy:
	npx cdk destroy

clean:
	rm -f ./package-lock.json
	rm -rf ./node_modules ./cdk.out
